require 'rails_helper'

RSpec.describe 'Items API', type: :request do
  let(:user) { create(:user) }
  let(:vault) { create(:vault, owner: user) }
  let(:headers) { auth_headers_for(user) }
  let(:ciphertext) { Base64.strict_encode64('fake-ciphertext-bytes') }
  let(:item_key) { Base64.strict_encode64('fake-wrapped-item-key') }

  it 'returns only ciphertext + opaque ids — never a title, tag or type' do
    item_id = SecureRandom.uuid
    put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    get "/api/v1/vaults/#{vault.id}/items/#{item_id}", headers: headers
    body = response.body
    expect(body).not_to match(/title|password|bank|tag/i)
    json = JSON.parse(body)
    expect(json['item']['current_version']['encrypted_payload']).to eq(ciphertext)
    expect(json['item']['current_version']['encrypted_item_key']).to eq(item_key)
  end

  it 'returns 409 on a stale base_revision and does not append another event' do
    item_id = SecureRandom.uuid
    put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    expect {
      put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
    }.not_to change { SyncEvent.where(vault_id: vault.id).count }
    expect(response).to have_http_status(:conflict)
    body = JSON.parse(response.body)
    expect(body['error']).to eq('revision_conflict')
    expect(body['current_revision']).to eq(1)
    expect(Item.find(item_id).current_revision).to eq(1)
  end

  it 'creates a tombstone on delete and hides the item from live reads' do
    item_id = SecureRandom.uuid
    put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
    delete "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 1 }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    get "/api/v1/vaults/#{vault.id}/items/#{item_id}", headers: headers
    expect(response).to have_http_status(:not_found)
  end

  it 'tombstones once with an optional opaque signature and conflicts on a repeated delete' do
    raw = 'item-delete-sig'.b
    signature = Base64.strict_encode64(raw)
    item_id = SecureRandom.uuid
    put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    delete "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 1, signature: signature }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    expect(response.body.downcase).not_to include('verified')
    stored = SyncEvent.find_by!(vault_id: vault.id, item_id: item_id, operation: 'delete')
    expect(stored.signature).to eq(raw)
    get "/api/v1/vaults/#{vault.id}/sync", headers: headers
    event = JSON.parse(response.body)['events'].find { |e| e['operation'] == 'delete' }
    expect(event['tombstone']).to eq(true)
    expect(event['encrypted_payload']).to be_nil
    expect(event['encrypted_item_key']).to be_nil
    expect(event['signature']).to eq(signature)
    expect(event.keys.grep(/verified/i)).to eq([])
    expect {
      delete "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 1 }, headers: headers, as: :json
    }.not_to change { SyncEvent.where(vault_id: vault.id).count }
    expect(response).to have_http_status(:conflict)
    body = JSON.parse(response.body)
    expect(body['error']).to eq('revision_conflict')
    expect(body['current_revision']).to eq(2)
    expect(body.to_s.downcase).not_to include('verified')
  end

  it 'does not let another user read the vault' do
    other = create(:user)
    get "/api/v1/vaults/#{vault.id}/items/#{SecureRandom.uuid}", headers: auth_headers_for(other)
    expect(response).to have_http_status(:not_found)
  end
end
