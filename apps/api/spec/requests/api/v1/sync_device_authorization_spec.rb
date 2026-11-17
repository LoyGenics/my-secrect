require 'rails_helper'

# Only an active (non-revoked) device of the vault owner may push or pull.
# Real sessions (Authentication::SessionTokens), real revocation
# (Devices::Revoke) — nothing stubbed.
RSpec.describe 'Sync device authorization', type: :request do
  let(:owner) { create(:user) }
  let(:device) { create(:device, user: owner) }
  let(:vault) { create(:vault, owner: owner) }
  let(:item_id) { SecureRandom.uuid }
  let(:payload) { Base64.strict_encode64('ciphertext-v1') }
  let(:key) { Base64.strict_encode64('wrapped-key') }

  def bearer(user, device) = { 'Authorization' => "Bearer #{Authentication::SessionTokens.issue(user: user, device: device)}" }
  def body = JSON.parse(response.body)

  def push(headers, base: 0, operation: 'upsert')
    params = { item_id: item_id, base_revision: base, operation: operation }
    params.merge!(encrypted_payload: Base64.strict_encode64("ciphertext-#{SecureRandom.hex(4)}"), encrypted_item_key: key) if operation == 'upsert'
    post "/api/v1/vaults/#{vault.id}/sync/push", params: params, headers: headers, as: :json
  end

  def pull(headers) = get("/api/v1/vaults/#{vault.id}/sync", headers: headers)

  let!(:owner_headers) { bearer(owner, device) }

  before do
    post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: payload, encrypted_item_key: key }, headers: owner_headers, as: :json
    expect(response).to have_http_status(:ok)
  end

  it 'lets an active device of the owner push and pull' do
    push(owner_headers, base: 1)
    expect(response).to have_http_status(:ok)
    pull(owner_headers)
    expect(response).to have_http_status(:ok)
    expect(body['events'].size).to eq(2)
  end

  context 'when the device was revoked (Devices::Revoke)' do
    before { Devices::Revoke.call(device: device) }

    it 'refuses push and pull with 401: its sessions are revoked with it' do
      expect { push(owner_headers, base: 1) }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:unauthorized)
      pull(owner_headers)
      expect(response).to have_http_status(:unauthorized)
      expect(body).to eq('error' => 'unauthorized')
    end
  end

  context 'when the device is revoked but a session for it is still live' do
    # e.g. a session issued in the same instant the device was revoked.
    before { device.update!(revoked_at: Time.current) }

    it 'refuses push and pull with 403 and writes nothing' do
      expect { push(owner_headers, base: 1) }.not_to change { [SyncEvent.count, ItemVersion.count] }
      expect(response).to have_http_status(:forbidden)
      expect(body).to eq('error' => 'device_not_authorized')
      expect { push(owner_headers, base: 1, operation: 'delete') }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:forbidden)
      pull(owner_headers)
      expect(response).to have_http_status(:forbidden)
      expect(body).to eq('error' => 'device_not_authorized')
    end

    it 'refuses the item and vault endpoints too' do
      get "/api/v1/vaults/#{vault.id}/items/#{item_id}", headers: owner_headers
      expect(response).to have_http_status(:forbidden)
      put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 1, encrypted_payload: Base64.strict_encode64('v2'), encrypted_item_key: key }, headers: owner_headers, as: :json
      expect(response).to have_http_status(:forbidden)
      delete "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 1 }, headers: owner_headers, as: :json
      expect(response).to have_http_status(:forbidden)
      get '/api/v1/vaults', headers: owner_headers
      expect(response).to have_http_status(:forbidden)
      get "/api/v1/vaults/#{vault.id}/key-envelopes", headers: owner_headers
      expect(response).to have_http_status(:forbidden)
      expect(Item.find(item_id).current_revision).to eq(1)
      expect(Item.find(item_id).deleted_at).to be_nil
    end
  end

  it 'refuses a session without a device (403 on push and pull)' do
    headers = bearer(owner, nil)
    expect { push(headers, base: 1) }.not_to change { SyncEvent.count }
    expect(response).to have_http_status(:forbidden)
    pull(headers)
    expect(response).to have_http_status(:forbidden)
    expect(body).to eq('error' => 'device_not_authorized')
  end

  it "refuses a session bound to another user's device (403 on push and pull)" do
    headers = bearer(owner, create(:device))
    expect { push(headers, base: 1) }.not_to change { SyncEvent.count }
    expect(response).to have_http_status(:forbidden)
    pull(headers)
    expect(response).to have_http_status(:forbidden)
  end

  # Same answer as a vault that does not exist (and as blobs/items): the
  # vault's existence is not revealed to another account.
  it "answers another user's active device with 404 on push and pull, writing and revealing nothing" do
    stranger = create(:user)
    headers = bearer(stranger, create(:device, user: stranger))
    expect { push(headers, base: 1) }.not_to change { [SyncEvent.count, ItemVersion.count] }
    expect(response).to have_http_status(:not_found)
    expect(body).to eq('error' => 'not_found')
    pull(headers)
    expect(response).to have_http_status(:not_found)
    expect(response.body).not_to include(item_id)
    get "/api/v1/vaults/#{SecureRandom.uuid}/sync", headers: headers
    expect(response).to have_http_status(:not_found)
  end
end
