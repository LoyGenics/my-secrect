require 'rails_helper'
require 'digest'
require 'securerandom'

# Account deletion uses real rows and real session tokens. User.destroy
# is not stubbed: the request runs Accounts::Delete against the database.
RSpec.describe 'Account deletion API', type: :request do
  def json_body = JSON.parse(response.body)

  def bearer_for(user, device: nil, stepped_up: false)
    device ||= create(:device, user: user)
    token = Authentication::SessionTokens.issue(user: user, device: device, user_agent: 'account-deletion-spec')
    if stepped_up
      Session.find_by!(token_digest: Digest::SHA256.hexdigest(token))
             .update!(step_up_verified_at: Time.current, step_up_method: 'passkey')
    end
    [token, device]
  end

  def auth_headers(token) = { 'Authorization' => "Bearer #{token}" }

  describe 'DELETE /api/v1/auth/account' do
    it 'deletes the caller, dependent records, and every session token' do
      user = create(:user)
      other = create(:user)
      token, device = bearer_for(user, stepped_up: true)
      extra_device = create(:device, user: user)
      extra_token = Authentication::SessionTokens.issue(user: user, device: extra_device)
      other_token, other_device = bearer_for(other, stepped_up: true)

      vault = create(:vault, owner: user)
      other_vault = create(:vault, owner: other)
      item = Item.create!(vault: vault, current_revision: 1)
      ItemVersion.create!(
        item: item, revision: 1, encryption_version: 1,
        encrypted_payload: 'payload', encrypted_item_key: 'item-key'
      )
      SyncEvent.create!(
        vault: vault, sequence: 1, item_id: item.id, revision: 1,
        operation: 'upsert', device: device
      )
      other_item = Item.create!(vault: other_vault, current_revision: 1)
      bystander_event = SyncEvent.create!(
        vault: other_vault, sequence: 1, item_id: other_item.id, revision: 1,
        operation: 'upsert', device: device
      )
      blob = Blob.create!(
        vault: vault, storage_key: "blob-#{SecureRandom.hex(4)}",
        ciphertext_size: 3, status: 'complete', encrypted_manifest: 'manifest'
      )
      BlobPart.create!(blob: blob, part_number: 1, object_key: "part-#{SecureRandom.hex(4)}", ciphertext_size: 3)
      KeyEnvelope.create!(vault: vault, recipient_id: user.id, key_version: 1, encrypted_key: 'own-envelope')
      KeyEnvelope.create!(vault: other_vault, recipient_id: user.id, key_version: 1, encrypted_key: 'shared-envelope')
      KeyEnvelope.create!(vault: other_vault, recipient_id: other.id, key_version: 1, encrypted_key: 'other-envelope')
      Share.create!(vault: vault, owner: user, recipient: other, permission: 'read', status: 'active', encrypted_key: 'owned-share')
      Share.create!(vault: other_vault, owner: other, recipient: user, permission: 'read', status: 'active', encrypted_key: 'received-share')
      DeviceCheckpoint.create!(device: device, vault: vault, last_sequence: 1)
      DeviceCheckpoint.create!(device: other_device, vault: vault, last_sequence: 0)
      Authenticator.create!(user: user, credential_id: SecureRandom.hex(8), public_key: 'pk', sign_count: 1)
      RecoveryCode.create!(user: user, code_digest: Digest::SHA256.hexdigest(SecureRandom.hex(8)))
      RecoveryVerifier.create!(user: user, public_key: 'verifier-public')
      RecoveryChallenge.create!(
        user: user, challenge_digest: Digest::SHA256.hexdigest('challenge'),
        challenge_encrypted: 'challenge-ciphertext', expires_at: 10.minutes.from_now
      )
      MfaChallenge.create!(
        user: user, device: device, token_digest: Digest::SHA256.hexdigest(SecureRandom.hex(8)),
        expires_at: 10.minutes.from_now
      )
      PasskeyChallenge.create!(
        email: user.email, challenge: SecureRandom.hex(8),
        kind: 'authentication', expires_at: 10.minutes.from_now
      )
      audit = AuditEvent.create!(user: user, device: device, event_type: 'step_up_verified', metadata: { 'method' => 'passkey' })

      user_id = user.id
      email = user.email
      vault_id = vault.id
      item_id = item.id
      blob_id = blob.id
      device_id = device.id

      delete '/api/v1/auth/account', headers: auth_headers(token), as: :json

      expect(response).to have_http_status(:no_content)
      expect(response.body).to eq('')
      expect(User.exists?(user_id)).to be(false)
      expect(Session.where(user_id: user_id)).to be_empty
      expect(Device.where(user_id: user_id)).to be_empty
      expect(Vault.where(owner_id: user_id)).to be_empty
      expect(Authenticator.where(user_id: user_id)).to be_empty
      expect(Share.where(owner_id: user_id)).to be_empty
      expect(Share.where(recipient_id: user_id)).to be_empty
      expect(Item.where(id: item_id)).to be_empty
      expect(ItemVersion.where(item_id: item_id)).to be_empty
      expect(SyncEvent.where(vault_id: vault_id)).to be_empty
      expect(Blob.where(id: blob_id)).to be_empty
      expect(BlobPart.where(blob_id: blob_id)).to be_empty
      expect(KeyEnvelope.where(vault_id: vault_id)).to be_empty
      expect(KeyEnvelope.where(recipient_id: user_id)).to be_empty
      expect(DeviceCheckpoint.where(device_id: device_id)).to be_empty
      expect(DeviceCheckpoint.where(vault_id: vault_id)).to be_empty
      expect(RecoveryCode.where(user_id: user_id)).to be_empty
      expect(RecoveryVerifier.where(user_id: user_id)).to be_empty
      expect(RecoveryChallenge.where(user_id: user_id)).to be_empty
      expect(MfaChallenge.where(user_id: user_id)).to be_empty
      expect(PasskeyChallenge.where(email: email)).to be_empty
      expect(Authentication::SessionTokens.verify(token)).to be_nil
      expect(Authentication::SessionTokens.verify(extra_token)).to be_nil

      kept_event = SyncEvent.find(bystander_event.id)
      expect(kept_event.vault_id).to eq(other_vault.id)
      expect(kept_event.device_id).to be_nil
      kept_audit = AuditEvent.find(audit.id)
      expect(kept_audit.user_id).to be_nil
      expect(kept_audit.device_id).to be_nil
      expect(kept_audit.metadata.to_json).not_to include(email)
      expect(KeyEnvelope.exists?(recipient_id: other.id, vault_id: other_vault.id)).to be(true)

      expect(User.exists?(other.id)).to be(true)
      expect(Vault.exists?(other_vault.id)).to be(true)
      expect(Item.exists?(other_item.id)).to be(true)
      expect(Device.exists?(other_device.id)).to be(true)

      get '/api/v1/auth/sessions', headers: auth_headers(token)
      expect(response).to have_http_status(:unauthorized)
      get '/api/v1/auth/sessions', headers: auth_headers(other_token)
      expect(response).to have_http_status(:ok)
    end

    it 'refuses a session that has not completed step-up' do
      user = create(:user)
      vault = create(:vault, owner: user)
      token, = bearer_for(user, stepped_up: false)

      delete '/api/v1/auth/account', headers: auth_headers(token), as: :json

      expect(response).to have_http_status(:forbidden)
      expect(json_body['error']).to eq('step_up_required')
      expect(User.exists?(user.id)).to be(true)
      expect(Vault.exists?(vault.id)).to be(true)
      expect(Authentication::SessionTokens.verify(token)).to be_present
    end

    it 'rejects an unauthenticated caller' do
      user = create(:user)

      delete '/api/v1/auth/account', as: :json

      expect(response).to have_http_status(:unauthorized)
      expect(json_body['error']).to eq('unauthorized')
      expect(User.exists?(user.id)).to be(true)
    end

    it 'does not delete a different account when that account id is supplied' do
      victim = create(:user)
      victim_vault = create(:vault, owner: victim)
      victim_token, = bearer_for(victim, stepped_up: true)
      caller = create(:user)
      caller_token, = bearer_for(caller, stepped_up: true)

      delete '/api/v1/auth/account',
             headers: auth_headers(caller_token),
             params: { user_id: victim.id, id: victim.id },
             as: :json

      expect(response).to have_http_status(:no_content)
      expect(User.exists?(victim.id)).to be(true)
      expect(Vault.exists?(victim_vault.id)).to be(true)
      expect(User.exists?(caller.id)).to be(false)
      expect(Authentication::SessionTokens.verify(caller_token)).to be_nil

      get '/api/v1/auth/sessions', headers: auth_headers(victim_token)
      expect(response).to have_http_status(:ok)
      get '/api/v1/auth/sessions', headers: auth_headers(caller_token)
      expect(response).to have_http_status(:unauthorized)
    end
  end
end
