require 'rails_helper'

# Revision rules, replays, rollback attempts and tombstones on
# POST /v1/vaults/:id/sync/push (specs/sync-protocol.md, "Server rules").
RSpec.describe 'Sync push revision rules', type: :request do
  let(:user) { create(:user) }
  let(:vault) { create(:vault, owner: user) }
  let(:headers) { auth_headers_for(user) }
  let(:item_id) { SecureRandom.uuid }
  let(:key) { b64('wrapped-item-key') }

  def b64(text) = Base64.strict_encode64(text)
  def body = JSON.parse(response.body)
  def events_for(id) = SyncEvent.where(item_id: id).order(:sequence).pluck(:revision, :operation)

  def push(payload: nil, base:, item: item_id, operation: 'upsert', item_key: key)
    params = { item_id: item, base_revision: base, operation: operation }
    params.merge!(encrypted_payload: payload, encrypted_item_key: item_key, encryption_version: 1) if operation == 'upsert'
    post "/api/v1/vaults/#{vault.id}/sync/push", params: params, headers: headers, as: :json
  end

  describe 'base_revision' do
    it 'refuses a base ahead of the current revision with 409 and writes nothing' do
      push(payload: b64('v1'), base: 0)
      expect { push(payload: b64('v2'), base: 5) }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:conflict)
      expect(body).to eq('error' => 'revision_conflict', 'current_revision' => 1)
      expect(ItemVersion.where(item_id: item_id).count).to eq(1)
    end

    it 'refuses a new item pushed with a base other than 0 (409, current_revision 0) and creates nothing' do
      expect { push(payload: b64('v1'), base: 3) }.not_to change { [Item.count, ItemVersion.count, SyncEvent.count] }
      expect(response).to have_http_status(:conflict)
      expect(body).to eq('error' => 'revision_conflict', 'current_revision' => 0)
    end

    it 'treats a missing base on a new item as 0' do
      post "/api/v1/vaults/#{vault.id}/sync/push", params: { item_id: item_id, operation: 'upsert', encrypted_payload: b64('v1'), encrypted_item_key: key }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect(body['revision']).to eq(1)
    end

    it 'accepts a base sent as a string of digits' do
      push(payload: b64('v1'), base: 0)
      push(payload: b64('v2'), base: '1')
      expect(response).to have_http_status(:ok)
      expect(body['revision']).to eq(2)
    end

    ['2x', '-1', -1, 1.5, true, 'abc'].each do |bad|
      it "rejects base_revision #{bad.inspect} with 422 and writes nothing" do
        push(payload: b64('v1'), base: 0)
        expect { push(payload: b64('v2'), base: bad) }.not_to change { [ItemVersion.count, SyncEvent.count] }
        expect(response).to have_http_status(:unprocessable_entity)
        expect(body).to eq('error' => 'invalid_request', 'message' => 'base_revision must be a non-negative integer')
        expect(Item.find(item_id).current_revision).to eq(1)
      end
    end
  end

  describe 'replayed pushes (response lost, client retries)' do
    it 'returns the original result for an identical upsert and appends nothing' do
      push(payload: b64('v1'), base: 0)
      first = body
      expect { push(payload: b64('v1'), base: 0) }.not_to change { [ItemVersion.count, SyncEvent.count] }
      expect(response).to have_http_status(:ok)
      expect(body).to eq('item_id' => item_id, 'revision' => 1, 'sequence' => first['sequence'], 'replayed' => true)
    end

    it 'still recognises the replay after another device wrote a newer revision' do
      push(payload: b64('v1'), base: 0)
      push(payload: b64('mine'), base: 1)
      mine = body
      push(payload: b64('theirs'), base: 2)
      expect { push(payload: b64('mine'), base: 1) }.not_to change { [ItemVersion.count, SyncEvent.count] }
      expect(response).to have_http_status(:ok)
      expect(body).to eq('item_id' => item_id, 'revision' => 2, 'sequence' => mine['sequence'], 'replayed' => true)
      expect(Item.find(item_id).current_revision).to eq(3)
    end

    it 'is not a replay when the wrapped item key differs: a stale write, 409' do
      push(payload: b64('v1'), base: 0)
      expect { push(payload: b64('v1'), base: 0, item_key: b64('another-key')) }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:conflict)
      expect(body).to eq('error' => 'revision_conflict', 'current_revision' => 1)
    end

    it 'returns the existing tombstone for a repeated delete, even after the item was restored' do
      push(payload: b64('v1'), base: 0)
      push(base: 1, operation: 'delete')
      tombstone = body
      push(payload: b64('v1'), base: 2) # restore
      expect(response).to have_http_status(:ok)
      expect { push(base: 1, operation: 'delete') }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:ok)
      expect(body).to eq('item_id' => item_id, 'revision' => 2, 'sequence' => tombstone['sequence'], 'replayed' => true)
      expect(Item.find(item_id).deleted_at).to be_nil
    end
  end

  describe 'rollback attempts (old ciphertext pushed as a new revision)' do
    it 'refuses a payload equal to an older version with 422 and writes nothing' do
      push(payload: b64('password-v1'), base: 0)
      push(payload: b64('password-v2'), base: 1)
      expect { push(payload: b64('password-v1'), base: 2) }.not_to change { [ItemVersion.count, SyncEvent.count] }
      expect(response).to have_http_status(:unprocessable_entity)
      expect(body).to eq('error' => 'ciphertext_reuse', 'revision' => 1)
      expect(Item.find(item_id).current_revision).to eq(2)
    end

    it 'refuses re-pushing the current version as a new revision' do
      push(payload: b64('v1'), base: 0)
      push(payload: b64('v1'), base: 1, item_key: b64('fresh-wrap'))
      expect(response).to have_http_status(:unprocessable_entity)
      expect(body).to eq('error' => 'ciphertext_reuse', 'revision' => 1)
    end

    it 'refuses delete-then-restore with an older version, but restores the newest one' do
      push(payload: b64('v1'), base: 0)
      push(payload: b64('v2'), base: 1)
      push(base: 2, operation: 'delete')
      expect { push(payload: b64('v1'), base: 3) }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:unprocessable_entity)
      expect(body).to eq('error' => 'ciphertext_reuse', 'revision' => 1)
      expect(Item.find(item_id).deleted_at).to be_present
      push(payload: b64('v2'), base: 3)
      expect(response).to have_http_status(:ok)
      expect(body['revision']).to eq(4)
      expect(Item.find(item_id).deleted_at).to be_nil
    end

    it 'refuses an item id that belongs to another vault' do
      other_vault = create(:vault, owner: user)
      post "/api/v1/vaults/#{other_vault.id}/sync/push", params: { item_id: item_id, base_revision: 0, operation: 'upsert', encrypted_payload: b64('x'), encrypted_item_key: key }, headers: headers, as: :json
      expect(response).to have_http_status(:ok)
      expect { push(payload: b64('y'), base: 0) }.not_to change { [Item.count, SyncEvent.count] }
      expect(response).to have_http_status(:unprocessable_entity)
      expect(body).to eq('error' => 'invalid_request', 'message' => 'item_id is already used by another vault')
      expect(Item.find(item_id).vault_id).to eq(other_vault.id)
    end
  end

  describe 'tombstones' do
    before do
      push(payload: b64('v1'), base: 0)
      push(base: 1, operation: 'delete')
    end

    it 'pulls as a tombstone event without ciphertext, after the upsert' do
      get "/api/v1/vaults/#{vault.id}/sync", headers: headers
      events = body['events'].map { |e| e.slice('revision', 'operation', 'tombstone', 'encrypted_payload') }
      expect(events).to eq([
        { 'revision' => 1, 'operation' => 'upsert', 'tombstone' => false, 'encrypted_payload' => b64('v1') },
        { 'revision' => 2, 'operation' => 'delete', 'tombstone' => true, 'encrypted_payload' => nil }
      ])
      expect(ItemVersion.where(item_id: item_id).pluck(:revision)).to eq([1]) # last ciphertext kept for restore
    end

    it 'does not let a write based on the pre-delete revision resurrect the item' do
      expect { push(payload: b64('edit-made-before-the-delete'), base: 1) }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:conflict)
      expect(body).to eq('error' => 'revision_conflict', 'current_revision' => 2)
      expect(Item.find(item_id).deleted_at).to be_present
    end

    it 'resurrects the item for a write based on the tombstone revision' do
      push(payload: b64('v2-after-restore'), base: 2)
      expect(response).to have_http_status(:ok)
      expect(body['revision']).to eq(3)
      expect(Item.find(item_id).deleted_at).to be_nil
      expect(events_for(item_id)).to eq([[1, 'upsert'], [2, 'delete'], [3, 'upsert']])
      get "/api/v1/vaults/#{vault.id}/items/#{item_id}", headers: headers
      expect(response).to have_http_status(:ok)
    end

    it 'treats deleting a tombstone at its own revision as a no-op, never a second tombstone' do
      sequence = SyncEvent.find_by!(item_id: item_id, revision: 2).sequence
      expect { push(base: 2, operation: 'delete') }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:ok)
      expect(body).to eq('item_id' => item_id, 'revision' => 2, 'sequence' => sequence, 'replayed' => true)
      expect(Item.find(item_id).current_revision).to eq(2)
    end

    it 'refuses a stale delete of a tombstone that was restored and edited since' do
      push(payload: b64('v2'), base: 2)
      push(payload: b64('v3'), base: 3)
      expect { push(base: 3, operation: 'delete') }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:conflict)
      expect(body).to eq('error' => 'revision_conflict', 'current_revision' => 4)
    end

    it 'returns 404 for a delete of an item the server never saw' do
      expect { push(base: 0, operation: 'delete', item: SecureRandom.uuid) }.not_to change { SyncEvent.count }
      expect(response).to have_http_status(:not_found)
    end
  end
end
