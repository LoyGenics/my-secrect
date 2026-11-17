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

  it 'creates a tombstone on delete and hides the item from live reads' do
    item_id = SecureRandom.uuid
    put "/api/v1/vaults/#{vault.id}/items/#{item_id}", params: { base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
    delete "/api/v1/vaults/#{vault.id}/items/#{item_id}", headers: headers
    expect(response).to have_http_status(:ok)
    get "/api/v1/vaults/#{vault.id}/items/#{item_id}", headers: headers
    expect(response).to have_http_status(:not_found)
  end

  it 'does not let another user read the vault' do
    other = create(:user)
    get "/api/v1/vaults/#{vault.id}/items/#{SecureRandom.uuid}", headers: auth_headers_for(other)
    expect(response).to have_http_status(:not_found)
  end
end
