require 'rails_helper'

RSpec.describe 'Sync API', type: :request do
  let(:user) { create(:user) }
  let(:vault) { create(:vault, owner: user) }
  let(:headers) { auth_headers_for(user) }
  let(:ciphertext) { Base64.strict_encode64('fake-ciphertext-bytes') }
  let(:item_key) { Base64.strict_encode64('fake-wrapped-item-key') }

  describe 'POST /v1/vaults/:id/sync/push' do
    it 'appends a new revision and returns a sequence' do
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: SecureRandom.uuid, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect(JSON.parse(response.body)['revision']).to eq(1)
      expect(JSON.parse(response.body)['sequence']).to eq(1)
    end

    it 'returns 409 on a stale base_revision instead of overwriting (no LWW)' do
      item_id = SecureRandom.uuid
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      expect(response).to have_http_status(:conflict)
      expect(JSON.parse(response.body)['error']).to eq('revision_conflict')
      expect(JSON.parse(response.body)['current_revision']).to eq(1)
    end

    it 'rejects unauthenticated pushes' do
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: SecureRandom.uuid, base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe 'GET /v1/vaults/:id/sync' do
    it 'pulls events since a cursor, in sequence order' do
      2.times do
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: SecureRandom.uuid, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      end
      get "/api/v1/vaults/#{vault.id}/sync", headers: headers
      body = JSON.parse(response.body)
      expect(body['events'].size).to eq(2)
      expect(body['events'].map { |e| e['sequence'] }).to eq([1, 2])
      expect(body['next_cursor']).to eq(2)
      get "/api/v1/vaults/#{vault.id}/sync?since=1", headers: headers
      expect(JSON.parse(response.body)['events'].size).to eq(1)
    end
  end
end
