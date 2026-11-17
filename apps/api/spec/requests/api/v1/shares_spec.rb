require 'rails_helper'
require 'digest'
require 'securerandom'

# E2EE item shares (specs/sharing-protocol.md §6). Real rows and session
# tokens; the Sharing domain is not stubbed. Ciphertext here is random
# bytes of the right sizes — the server never interprets it, and the real
# crypto is exercised by tests/sharing-e2e against this same API.
RSpec.describe 'Shares API', type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:owner) { create(:user) }
  let(:recipient) { create(:user) }
  let(:stranger) { create(:user) }
  let(:owner_headers) { auth_headers_for(owner) }
  let(:recipient_headers) { auth_headers_for(recipient) }
  let(:stranger_headers) { auth_headers_for(stranger) }
  let!(:owner_key) { IdentityKey.create!(user: owner, public_key: SecureRandom.random_bytes(32), encrypted_secret_key: SecureRandom.random_bytes(120)) }
  let!(:recipient_key) { IdentityKey.create!(user: recipient, public_key: SecureRandom.random_bytes(32), encrypted_secret_key: SecureRandom.random_bytes(120)) }
  let!(:stranger_key) { IdentityKey.create!(user: stranger, public_key: SecureRandom.random_bytes(32), encrypted_secret_key: SecureRandom.random_bytes(120)) }
  let(:payload) { SecureRandom.random_bytes(200) }
  let(:wrapped_key) { SecureRandom.random_bytes(72) }

  def b64(bytes) = Base64.strict_encode64(bytes)
  def json = JSON.parse(response.body)

  def share_params(**overrides)
    {
      id: SecureRandom.uuid, recipient_id: recipient.id, recipient_public_key: b64(recipient_key.public_key),
      permission: 'read', expires_at: nil, encrypted_payload: b64(payload), encrypted_item_key: b64(wrapped_key),
      encrypted_owner_metadata: b64(SecureRandom.random_bytes(90))
    }.merge(overrides)
  end

  def create_share(**overrides)
    post '/api/v1/shares', params: share_params(**overrides), headers: owner_headers, as: :json
    expect(response).to have_http_status(:created), response.body
    ItemShare.find(json.dig('share', 'id'))
  end

  def accept(share, as_headers: recipient_headers, owner_public_key: owner_key.public_key)
    post "/api/v1/shares/#{share.id}/accept", params: { owner_public_key: b64(owner_public_key) }, headers: as_headers, as: :json
  end

  def read_record(share, as_headers:) = get("/api/v1/shares/#{share.id}/record", headers: as_headers)

  def write_record(share, as_headers:, base_revision:, bytes: SecureRandom.random_bytes(150))
    put "/api/v1/shares/#{share.id}/record",
        params: { base_revision: base_revision, encrypted_payload: b64(bytes), encrypted_item_key: b64(SecureRandom.random_bytes(72)) },
        headers: as_headers, as: :json
  end

  def active_share(**overrides)
    share = create_share(**overrides)
    accept(share)
    expect(response).to have_http_status(:ok), response.body
    share.reload
  end

  describe 'create' do
    it 'stores a PENDING share with revision 1 as raw bytes and audits it' do
      share = create_share(permission: 'write', expires_at: 2.days.from_now.iso8601)
      expect(share.status).to eq('pending')
      expect(share.revision).to eq(1)
      expect(share.permission).to eq('write')
      expect(share.owner_id).to eq(owner.id)
      expect(share.recipient_id).to eq(recipient.id)
      expect(share.last_writer_id).to eq(owner.id)
      expect(share.encrypted_payload.b).to eq(payload.b)
      expect(share.encrypted_item_key.b).to eq(wrapped_key.b)
      expect(share.owner_public_key.b).to eq(owner_key.public_key.b)
      expect(share.recipient_public_key.b).to eq(recipient_key.public_key.b)
      expect(json.dig('share', 'status')).to eq('pending')
      expect(json.dig('share', 'role')).to eq('owner')
      expect(AuditEvent.where(user_id: owner.id, event_type: 'share_created').pluck(:metadata))
        .to eq([{ 'share_id' => share.id, 'permission' => 'write' }])
    end

    it 'rejects invalid requests without creating anything' do
      cases = {
        { id: 'not-a-uuid' } => :unprocessable_entity,
        { permission: 'admin' } => :unprocessable_entity,
        { recipient_id: owner.id } => :unprocessable_entity,
        { recipient_id: SecureRandom.uuid } => :unprocessable_entity,
        { recipient_public_key: b64(SecureRandom.random_bytes(32)) } => :conflict,
        { recipient_public_key: b64(SecureRandom.random_bytes(16)) } => :unprocessable_entity,
        { expires_at: 1.minute.ago.iso8601 } => :unprocessable_entity,
        { expires_at: 'tomorrow' } => :unprocessable_entity,
        { encrypted_item_key: b64(SecureRandom.random_bytes(71)) } => :unprocessable_entity,
        { encrypted_payload: 'not base64!!' } => :unprocessable_entity,
        { encrypted_payload: '' } => :unprocessable_entity,
        { encrypted_owner_metadata: nil } => :unprocessable_entity
      }
      cases.each do |overrides, status|
        post '/api/v1/shares', params: share_params(**overrides), headers: owner_headers, as: :json
        expect(response).to have_http_status(status), "#{overrides.keys.first}: #{response.status} #{response.body}"
      end
      expect(json.fetch('error')).to eq('invalid_request')
      expect(ItemShare.count).to eq(0)
    end

    it 'returns 409 recipient_key_mismatch when the pinned key is not the registered one' do
      post '/api/v1/shares', params: share_params(recipient_public_key: b64(stranger_key.public_key)), headers: owner_headers, as: :json
      expect(response).to have_http_status(:conflict)
      expect(json.fetch('error')).to eq('recipient_key_mismatch')
      expect(ItemShare.count).to eq(0)
    end

    it 'requires the owner and the recipient to have identity keys' do
      owner_key.destroy!
      post '/api/v1/shares', params: share_params, headers: owner_headers, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json.fetch('message')).to include('identity key')

      IdentityKey.create!(user: owner, public_key: SecureRandom.random_bytes(32), encrypted_secret_key: SecureRandom.random_bytes(120))
      recipient_key.destroy!
      post '/api/v1/shares', params: share_params, headers: owner_headers, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json.fetch('message')).to eq('recipient has no identity key')
      expect(ItemShare.count).to eq(0)
    end

    it 'returns 409 when the client-chosen id is already taken' do
      share = create_share
      post '/api/v1/shares', params: share_params(id: share.id), headers: owner_headers, as: :json
      expect(response).to have_http_status(:conflict)
      expect(json.fetch('error')).to eq('share_id_taken')
      expect(ItemShare.count).to eq(1)
    end
  end

  describe 'no access without a share' do
    it 'gives other users 404 on every share endpoint and hides the share from their list' do
      share = active_share(permission: 'write')
      read_record(share, as_headers: stranger_headers)
      expect(response).to have_http_status(:not_found)
      write_record(share, as_headers: stranger_headers, base_revision: 1)
      expect(response).to have_http_status(:not_found)
      accept(share, as_headers: stranger_headers)
      expect(response).to have_http_status(:not_found)
      delete "/api/v1/shares/#{share.id}", headers: stranger_headers
      expect(response).to have_http_status(:not_found)
      get '/api/v1/shares', headers: stranger_headers
      expect(response).to have_http_status(:ok)
      expect(json.fetch('shares')).to eq([])

      share.reload
      expect(share.status).to eq('active')
      expect(share.revision).to eq(1)
      expect(share.encrypted_payload.b).to eq(payload.b)
    end

    it 'returns 404 for an unknown or malformed share id and 401 without a session' do
      read_record(Struct.new(:id).new(SecureRandom.uuid), as_headers: owner_headers)
      expect(response).to have_http_status(:not_found)
      read_record(Struct.new(:id).new('not-a-uuid'), as_headers: owner_headers)
      expect(response).to have_http_status(:not_found)
      get '/api/v1/shares'
      expect(response).to have_http_status(:unauthorized)
      post '/api/v1/shares', params: share_params, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(ItemShare.count).to eq(0)
    end
  end

  describe 'list' do
    it 'shows each party its own role; only the owner gets the owner metadata' do
      share = create_share
      get '/api/v1/shares', headers: owner_headers
      owner_view = json.fetch('shares')
      expect(owner_view.map { |s| s['id'] }).to eq([share.id])
      expect(owner_view.first).to include('role' => 'owner', 'status' => 'pending', 'expired' => false, 'revision' => 1)
      expect(owner_view.first.dig('recipient', 'email')).to eq(recipient.email)
      expect(owner_view.first['encrypted_owner_metadata']).to eq(b64(share.encrypted_owner_metadata))

      get '/api/v1/shares', headers: recipient_headers
      recipient_view = json.fetch('shares')
      expect(recipient_view.map { |s| s['id'] }).to eq([share.id])
      expect(recipient_view.first).to include('role' => 'recipient', 'encrypted_owner_metadata' => nil)
      expect(recipient_view.first.dig('owner', 'email')).to eq(owner.email)
      expect(recipient_view.first['owner_public_key']).to eq(b64(owner_key.public_key))
      expect(response.body).not_to include(b64(payload))
    end
  end

  describe 'pending share (key exchange before activation)' do
    it 'gives the recipient the wrapped key only, never the payload, and refuses writes' do
      share = create_share(permission: 'write')
      read_record(share, as_headers: recipient_headers)
      expect(response).to have_http_status(:ok)
      expect(json.fetch('record')).to include('revision' => 1, 'encrypted_item_key' => b64(wrapped_key), 'encrypted_payload' => nil)

      write_record(share, as_headers: recipient_headers, base_revision: 1)
      expect(response).to have_http_status(:forbidden)
      expect(json.fetch('error')).to eq('share_not_active')
      expect(share.reload.revision).to eq(1)
    end

    it 'lets the owner read the full record and update it before acceptance' do
      share = create_share
      read_record(share, as_headers: owner_headers)
      expect(json.dig('record', 'encrypted_payload')).to eq(b64(payload))
      write_record(share, as_headers: owner_headers, base_revision: 1)
      expect(response).to have_http_status(:ok)
      expect(json.dig('record', 'revision')).to eq(2)
      expect(share.reload.status).to eq('pending')
    end
  end

  describe 'accept' do
    it 'activates only for the recipient presenting the owner key the share was made under' do
      share = create_share
      accept(share, as_headers: owner_headers)
      expect(response).to have_http_status(:forbidden)

      accept(share, owner_public_key: SecureRandom.random_bytes(32))
      expect(response).to have_http_status(:conflict)
      expect(json.fetch('error')).to eq('owner_key_mismatch')
      expect(share.reload.status).to eq('pending')

      accept(share)
      expect(response).to have_http_status(:ok)
      expect(json.dig('share', 'status')).to eq('active')
      expect(share.reload.status).to eq('active')
      expect(share.accepted_at).to be_present
      expect(AuditEvent.where(user_id: recipient.id, event_type: 'share_accepted').pluck(:metadata)).to eq([{ 'share_id' => share.id }])

      accept(share)
      expect(response).to have_http_status(:conflict)
      expect(json.fetch('error')).to eq('share_not_pending')
    end

    it "refuses when the owner's registered key no longer matches the share" do
      share = create_share
      owner_key.update!(public_key: SecureRandom.random_bytes(32))
      accept(share, owner_public_key: share.owner_public_key)
      expect(response).to have_http_status(:conflict)
      expect(json.fetch('error')).to eq('owner_key_mismatch')
      expect(share.reload.status).to eq('pending')
    end
  end

  describe 'active share permissions' do
    it 'lets a read recipient read the exact ciphertext but never write' do
      share = active_share(permission: 'read')
      read_record(share, as_headers: recipient_headers)
      expect(response).to have_http_status(:ok)
      expect(json.fetch('record')).to include('revision' => 1, 'encrypted_payload' => b64(payload), 'encrypted_item_key' => b64(wrapped_key))

      write_record(share, as_headers: recipient_headers, base_revision: 1)
      expect(response).to have_http_status(:forbidden)
      expect(json.fetch('error')).to eq('write_not_permitted')
      share.reload
      expect(share.revision).to eq(1)
      expect(share.encrypted_payload.b).to eq(payload.b)
      expect(share.last_writer_id).to eq(owner.id)
    end

    it 'lets a write recipient write a new revision, revision-checked like sync' do
      share = active_share(permission: 'write')
      edit = SecureRandom.random_bytes(180)
      write_record(share, as_headers: recipient_headers, base_revision: 1, bytes: edit)
      expect(response).to have_http_status(:ok)
      expect(json.dig('record', 'revision')).to eq(2)
      expect(json.dig('record', 'last_writer_id')).to eq(recipient.id)

      read_record(share, as_headers: owner_headers)
      expect(json.dig('record', 'encrypted_payload')).to eq(b64(edit))
      expect(json.dig('record', 'last_writer_id')).to eq(recipient.id)

      write_record(share, as_headers: owner_headers, base_revision: 1)
      expect(response).to have_http_status(:conflict)
      expect(json).to include('error' => 'revision_conflict', 'current_revision' => 2)

      write_record(share, as_headers: owner_headers, base_revision: 2)
      expect(response).to have_http_status(:ok)
      expect(share.reload.revision).to eq(3)
      expect(AuditEvent.where(event_type: 'share_record_written').pluck(:metadata)).to contain_exactly(
        { 'share_id' => share.id, 'revision' => 2, 'by' => 'recipient' },
        { 'share_id' => share.id, 'revision' => 3, 'by' => 'owner' }
      )
    end

    it 'rejects a write with a missing base_revision or malformed ciphertext' do
      share = active_share(permission: 'write')
      put "/api/v1/shares/#{share.id}/record", params: { encrypted_payload: b64(payload), encrypted_item_key: b64(wrapped_key) }, headers: recipient_headers, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      put "/api/v1/shares/#{share.id}/record", params: { base_revision: 1, encrypted_payload: b64(payload), encrypted_item_key: b64(SecureRandom.random_bytes(10)) }, headers: recipient_headers, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      expect(share.reload.revision).to eq(1)
    end
  end

  describe 'revocation' do
    it 'stops all access, erases the ciphertext and is idempotent' do
      share = active_share(permission: 'write')
      delete "/api/v1/shares/#{share.id}", headers: owner_headers
      expect(response).to have_http_status(:no_content)

      share.reload
      expect(share.status).to eq('revoked')
      expect(share.revoked_at).to be_present
      expect(share.encrypted_payload).to be_nil
      expect(share.encrypted_item_key).to be_nil
      expect(share.encrypted_owner_metadata).to be_nil

      read_record(share, as_headers: recipient_headers)
      expect(response).to have_http_status(:forbidden)
      expect(json.fetch('error')).to eq('share_revoked')
      write_record(share, as_headers: recipient_headers, base_revision: 1)
      expect(response).to have_http_status(:forbidden)
      expect(json.fetch('error')).to eq('share_revoked')
      read_record(share, as_headers: owner_headers)
      expect(response).to have_http_status(:forbidden)

      delete "/api/v1/shares/#{share.id}", headers: owner_headers
      expect(response).to have_http_status(:no_content)
      expect(AuditEvent.where(event_type: 'share_revoked').pluck(:metadata)).to eq([{ 'share_id' => share.id, 'by' => 'owner' }])

      get '/api/v1/shares', headers: recipient_headers
      expect(json.fetch('shares').map { |s| s.slice('id', 'status') }).to eq([{ 'id' => share.id, 'status' => 'revoked' }])
    end

    it 'cannot be accepted after revocation' do
      share = create_share
      delete "/api/v1/shares/#{share.id}", headers: owner_headers
      accept(share)
      expect(response).to have_http_status(:forbidden)
      expect(json.fetch('error')).to eq('share_revoked')
      expect(share.reload.status).to eq('revoked')
    end

    it 'lets the recipient decline a pending share' do
      share = create_share
      delete "/api/v1/shares/#{share.id}", headers: recipient_headers
      expect(response).to have_http_status(:no_content)
      expect(share.reload.status).to eq('revoked')
      expect(share.encrypted_payload).to be_nil
      expect(AuditEvent.where(event_type: 'share_revoked').pluck(:user_id, :metadata)).to eq([[recipient.id, { 'share_id' => share.id, 'by' => 'recipient' }]])
    end
  end

  describe 'expiry' do
    it 'refuses every record access and acceptance once expired, for both parties' do
      active = active_share(permission: 'write', expires_at: 10.minutes.from_now.iso8601)
      pending = create_share(expires_at: 10.minutes.from_now.iso8601)

      travel 20.minutes do # session tokens live 1h, so stay inside that
        read_record(active, as_headers: recipient_headers)
        expect(response).to have_http_status(:forbidden)
        expect(json.fetch('error')).to eq('share_expired')
        write_record(active, as_headers: recipient_headers, base_revision: 1)
        expect(response).to have_http_status(:forbidden)
        expect(json.fetch('error')).to eq('share_expired')
        read_record(active, as_headers: owner_headers)
        expect(response).to have_http_status(:forbidden)
        accept(pending)
        expect(response).to have_http_status(:forbidden)
        expect(json.fetch('error')).to eq('share_expired')

        get '/api/v1/shares', headers: recipient_headers
        expect(json.fetch('shares').map { |s| s['expired'] }).to eq([true, true])

        delete "/api/v1/shares/#{active.id}", headers: owner_headers
        expect(response).to have_http_status(:no_content)
      end
      expect(active.reload.revision).to eq(1)
      expect(pending.reload.status).to eq('pending')
    end
  end

  describe 'account deletion' do
    it "removes the user's identity key and every share they own or received" do
      owned = create_share
      received = ItemShare.create!(
        id: SecureRandom.uuid, owner: stranger, recipient: owner, permission: 'read', status: 'active',
        owner_public_key: stranger_key.public_key, recipient_public_key: owner_key.public_key, revision: 1,
        last_writer_id: stranger.id, encrypted_payload: payload, encrypted_item_key: wrapped_key,
        encrypted_owner_metadata: SecureRandom.random_bytes(60)
      )
      unrelated = ItemShare.create!(
        id: SecureRandom.uuid, owner: stranger, recipient: recipient, permission: 'read', status: 'pending',
        owner_public_key: stranger_key.public_key, recipient_public_key: recipient_key.public_key, revision: 1,
        last_writer_id: stranger.id, encrypted_payload: payload, encrypted_item_key: wrapped_key,
        encrypted_owner_metadata: SecureRandom.random_bytes(60)
      )
      token = Authentication::SessionTokens.issue(user: owner, device: create(:device, user: owner))
      Session.find_by!(token_digest: Digest::SHA256.hexdigest(token)).update!(step_up_verified_at: Time.current, step_up_method: 'passkey')

      delete '/api/v1/auth/account', headers: { 'Authorization' => "Bearer #{token}" }, as: :json

      expect(response).to have_http_status(:no_content)
      expect(IdentityKey.where(user_id: owner.id)).to be_empty
      expect(ItemShare.where(id: [owned.id, received.id])).to be_empty
      expect(ItemShare.where(id: unrelated.id).count).to eq(1)
      expect(IdentityKey.where(user_id: [recipient.id, stranger.id]).count).to eq(2)
    end
  end
end
