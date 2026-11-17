require 'rails_helper'

RSpec.describe ItemVersion, type: :model do
  it 'rejects a duplicate revision for the same item' do
    item = create(:item)
    # No factory for item_version: versions are only created through EncryptedRecords::Upsert.
    v1 = ItemVersion.create(item: item, revision: 1, encrypted_payload: 'a', encrypted_item_key: 'b', encryption_version: 1)
    expect(v1).to be_persisted
    v2 = ItemVersion.new(item: item, revision: 1, encrypted_payload: 'c', encrypted_item_key: 'd', encryption_version: 1)
    expect(v2).not_to be_valid
  end
end
