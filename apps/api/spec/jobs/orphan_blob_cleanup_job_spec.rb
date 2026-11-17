require 'rails_helper'

# Runs the real job against the real provider interface (Blobs.storage_provider)
# backed by the in-memory adapter. Nothing under test is mocked.
RSpec.describe OrphanBlobCleanupJob do
  let(:store) { InMemoryStorage.new }
  let(:vault) { create(:vault) }

  before { Blobs.storage_provider = store }
  after { Blobs.storage_provider = nil }

  def seed(status:, upload_expires_at: nil, parts: 2, created_at: Time.current)
    id = SecureRandom.uuid
    blob = Blob.create!(id: id, vault: vault, storage_key: "vaults/#{vault.id}/blobs/#{id}", ciphertext_size: 3 * parts,
                        status: status, encrypted_manifest: 'm', upload_expires_at: upload_expires_at, created_at: created_at)
    keys = (1..parts).map do |n|
      key = "#{blob.storage_key}/part-#{format('%05d', n)}"
      BlobPart.create!(blob: blob, part_number: n, object_key: key, ciphertext_size: 3)
      store.put(key, 'cip', at: created_at)
      key
    end
    [blob, keys]
  end

  it 'deletes expired upload sessions — every object under their prefix, then the rows' do
    expired, expired_keys = seed(status: 'uploading', upload_expires_at: 1.minute.ago, created_at: 2.days.ago)
    stray = "#{expired.storage_key}/part-00009" # an object with no part row (never listed by the session) is removed too
    store.put(stray, 'x', at: 2.days.ago)
    legacy, legacy_keys = seed(status: 'uploading', upload_expires_at: nil, created_at: 25.hours.ago)
    live, live_keys = seed(status: 'uploading', upload_expires_at: 1.hour.from_now)
    done, done_keys = seed(status: 'complete', created_at: 3.days.ago)

    result = described_class.new.perform

    expect(result).to eq(expired_blobs: 2, deleted_objects: 5, orphan_objects: 0)
    expect(Blob.where(id: [expired.id, legacy.id])).to be_empty
    expect(BlobPart.where(blob_id: [expired.id, legacy.id])).to be_empty
    expect(store.objects.keys).to match_array(live_keys + done_keys)
    expect(store.delete_log).to match_array(expired_keys + [stray] + legacy_keys)
    expect(Blob.where(id: [live.id, done.id]).pluck(:status)).to match_array(%w[uploading complete])
  end

  it 'deletes orphan objects (no blob row) once older than the presign TTL; leaves fresh ones and foreign keys' do
    _done, done_keys = seed(status: 'complete', created_at: 3.days.ago)
    old_orphan = "vaults/#{vault.id}/blobs/#{SecureRandom.uuid}/part-00001"
    fresh_orphan = "vaults/#{vault.id}/blobs/#{SecureRandom.uuid}/part-00001"
    foreign = 'backups/2026-11-17.tar'
    store.put(old_orphan, 'x', at: 10.minutes.ago)
    store.put(fresh_orphan, 'x', at: 1.minute.ago)
    store.put(foreign, 'x', at: 30.days.ago)

    expect(described_class.new.perform).to eq(expired_blobs: 0, deleted_objects: 0, orphan_objects: 1)
    expect(store.objects.keys).to match_array(done_keys + [fresh_orphan, foreign])
  end

  # #perform raises; ApplicationJob's retry_on re-enqueues the job in production.
  it 'keeps the rows when storage refuses a delete, and a retry finishes the job' do
    expired, keys = seed(status: 'uploading', upload_expires_at: 1.minute.ago, parts: 3)
    store.fail_deletes_for = [keys[1]]

    expect { described_class.new.perform }.to raise_error(Aws::S3::Errors::InternalError)
    expect(Blob.exists?(expired.id)).to be(true)
    expect(BlobPart.where(blob_id: expired.id).count).to eq(3)

    store.fail_deletes_for = []
    expect(described_class.new.perform).to eq(expired_blobs: 1, deleted_objects: 3, orphan_objects: 0) # part 1 again: deletes are idempotent
    expect(Blob.exists?(expired.id)).to be(false)
    expect(store.objects).to be_empty
  end
end
