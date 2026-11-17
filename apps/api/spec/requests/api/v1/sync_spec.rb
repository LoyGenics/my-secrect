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
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      }.not_to change { SyncEvent.where(vault_id: vault.id).count }
      expect(response).to have_http_status(:conflict)
      expect(JSON.parse(response.body)['error']).to eq('revision_conflict')
      expect(JSON.parse(response.body)['current_revision']).to eq(1)
      expect(Item.find(item_id).current_revision).to eq(1)
    end

    it 'rejects unauthenticated pushes' do
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: SecureRandom.uuid, base_revision: 0, encrypted_payload: ciphertext, encrypted_item_key: item_key }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end

    # Signature bytes are stored and echoed. The server does not authenticate them.
    it 'round-trips a provided signature as opaque base64 without calling it verified' do
      raw = 'opaque-bytes'.b
      signature = Base64.strict_encode64(raw)
      delete_raw = 'opaque-delete'.b
      delete_signature = Base64.strict_encode64(delete_raw)
      item_id = SecureRandom.uuid
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1, signature: signature }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect(response.body.downcase).not_to include('verified')
      stored = SyncEvent.find_by!(vault_id: vault.id, item_id: item_id, operation: 'upsert')
      expect(stored.signature).to eq(raw)
      expect(stored.signature).not_to eq(signature)
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 1, operation: 'delete', signature: delete_signature }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect(response.body.downcase).not_to include('verified')
      stored_delete = SyncEvent.find_by!(vault_id: vault.id, item_id: item_id, operation: 'delete')
      expect(stored_delete.signature).to eq(delete_raw)
      get "/api/v1/vaults/#{vault.id}/sync", headers: headers
      expect(response.body.downcase).not_to include('verified')
      events = JSON.parse(response.body)['events']
      upsert = events.find { |e| e['operation'] == 'upsert' }
      tombstone = events.find { |e| e['operation'] == 'delete' }
      expect(upsert['signature']).to eq(signature)
      expect(tombstone['signature']).to eq(delete_signature)
      expect(upsert.keys.grep(/verified/i)).to eq([])
      expect(tombstone.keys.grep(/verified/i)).to eq([])
    end

    it 'rejects invalid signature base64 with 422 and does not append an event' do
      item_id = SecureRandom.uuid
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key, signature: '@@@not-base64@@@' }, headers: headers, as: :json
      }.not_to change { SyncEvent.where(vault_id: vault.id).count }
      expect(response).to have_http_status(:unprocessable_entity)
      body = JSON.parse(response.body)
      expect(body['error']).to eq('invalid_request')
      expect(body.to_s.downcase).not_to include('verified')
      expect(Item.where(id: item_id)).to be_empty
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: SecureRandom.uuid, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      created_id = JSON.parse(response.body)['item_id']
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: created_id, operation: 'delete', signature: '@@@not-base64@@@' }, headers: headers, as: :json
      }.not_to change { SyncEvent.where(vault_id: vault.id).count }
      expect(response).to have_http_status(:unprocessable_entity)
      expect(Item.find(created_id).deleted_at).to be_nil
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

    it 'includes encrypted_payload, encrypted_item_key, and encryption_version on an upsert' do
      item_id = SecureRandom.uuid
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      get "/api/v1/vaults/#{vault.id}/sync", headers: headers
      expect(response).to have_http_status(:ok)
      event = JSON.parse(response.body)['events'].find { |e| e['item_id'] == item_id }
      expect(event['operation']).to eq('upsert')
      expect(event['tombstone']).to eq(false)
      # Single encoding: pull returns exactly the base64 the client pushed
      # (regression: it used to return base64(base64(ciphertext))).
      expect(event['encrypted_payload']).to eq(ciphertext)
      expect(event['encrypted_item_key']).to eq(item_key)
      expect(event['encryption_version']).to eq(1)
      expect(event['signature']).to be_nil
    end

    it 'stores the decoded ciphertext bytes, not the base64 text' do
      item_id = SecureRandom.uuid
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      stored = ItemVersion.find_by!(item_id: item_id, revision: 1)
      expect(stored.encrypted_payload.b).to eq('fake-ciphertext-bytes'.b)
      expect(stored.encrypted_item_key.b).to eq('fake-wrapped-item-key'.b)
    end

    it 'rejects a non-uuid item_id with 422 instead of minting a different id' do
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: 'item_0123456789abcdef01234567', base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      }.not_to change { [Item.count, SyncEvent.count] }
      expect(response).to have_http_status(:unprocessable_entity)
      expect(JSON.parse(response.body)['error']).to eq('invalid_request')
    end

    it 'rejects non-base64 ciphertext with 422 and appends nothing' do
      item_id = SecureRandom.uuid
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: '@@not base64@@', encrypted_item_key: item_key }, headers: headers, as: :json
      }.not_to change { SyncEvent.where(vault_id: vault.id).count }
      expect(response).to have_http_status(:unprocessable_entity)
      expect(Item.where(id: item_id)).to be_empty
    end

    it 'returns a tombstone with null ciphertext after a delete push' do
      item_id = SecureRandom.uuid
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key, encryption_version: 1 }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 1, operation: 'delete' }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 1, operation: 'delete' }, headers: headers, as: :json
      }.not_to change { SyncEvent.where(vault_id: vault.id).count }
      expect(response).to have_http_status(:conflict)
      expect(JSON.parse(response.body)['error']).to eq('revision_conflict')
      expect(JSON.parse(response.body)['current_revision']).to eq(2)
      expect(SyncEvent.where(vault_id: vault.id, item_id: item_id, operation: 'delete').count).to eq(1)
      get "/api/v1/vaults/#{vault.id}/sync", headers: headers
      event = JSON.parse(response.body)['events'].find { |e| e['operation'] == 'delete' }
      expect(event['item_id']).to eq(item_id)
      expect(event['tombstone']).to eq(true)
      expect(event['encrypted_payload']).to be_nil
      expect(event['encrypted_item_key']).to be_nil
      expect(event['signature']).to be_nil
    end

    it 'returns 409 when a delete omits base_revision and does not append an event' do
      item_id = SecureRandom.uuid
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: ciphertext, encrypted_item_key: item_key }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect {
        post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, operation: 'delete' }, headers: headers, as: :json
      }.not_to change { SyncEvent.where(vault_id: vault.id).count }
      expect(response).to have_http_status(:conflict)
      expect(JSON.parse(response.body)['error']).to eq('revision_conflict')
      expect(JSON.parse(response.body)['current_revision']).to eq(1)
      expect(Item.find(item_id).deleted_at).to be_nil
    end

    it 'rejects an unauthenticated pull' do
      get "/api/v1/vaults/#{vault.id}/sync"
      expect(response).to have_http_status(:unauthorized)
    end
  end
end
