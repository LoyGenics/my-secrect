require 'rails_helper'

# Runs Accounts::Delete against the real provider interface (installed via
# Blobs.storage_provider) backed by an in-memory adapter. Nothing under test
# is mocked.
RSpec.describe Accounts::Delete do
  let(:store) { InMemoryStorage.new }
  before { Blobs.storage_provider = store }
  after { Blobs.storage_provider = nil }

  def seed(vault, parts: 2, status: 'complete')
    blob = Blob.create!(vault: vault, storage_key: "vaults/#{vault.id}/blobs/#{SecureRandom.uuid}",
                        ciphertext_size: 3, status: status, encrypted_manifest: 'm')
    (1..parts).map do |n|
      key = "#{blob.storage_key}/part-#{format('%05d', n)}"
      BlobPart.create!(blob: blob, part_number: n, object_key: key, ciphertext_size: 3)
      store.put(key, 'cip')
      key
    end
  end

  it 'removes every ciphertext object of the user and leaves other users untouched' do
    user = create(:user); other = create(:user)
    mine = seed(create(:vault, owner: user)) + seed(create(:vault, owner: user), status: 'uploading', parts: 1)
    theirs = seed(create(:vault, owner: other))

    described_class.call(user: user)

    expect(store.objects.keys).to match_array(theirs)
    expect(mine.none? { |k| store.objects.key?(k) }).to be(true)
    expect(User.exists?(user.id)).to be(false)
    expect(Blob.where(vault_id: other.vaults.pluck(:id)).count).to eq(1)
  end

  it 'fails closed: on a storage error nothing in the DB is deleted, orphans stay referenced, retry completes' do
    user = create(:user)
    keys = seed(create(:vault, owner: user), parts: 3)
    store.fail_deletes_for = [keys[1]]

    expect { described_class.call(user: user) }.to raise_error(described_class::StorageDeletionError)

    expect(User.exists?(user.id)).to be(true)
    expect(BlobPart.where(object_key: keys).count).to eq(3) # rows still point at the leftover object
    expect(store.objects.keys).to eq([keys[1]])
    expect(AuditEvent.where(user_id: user.id, event_type: 'account_deletion_storage_failed').count).to eq(1)

    store.fail_deletes_for = []
    described_class.call(user: user)
    expect(store.objects).to be_empty
    expect(User.exists?(user.id)).to be(false)
  end
end
