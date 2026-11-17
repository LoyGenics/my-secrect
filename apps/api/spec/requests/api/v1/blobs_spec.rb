require 'rails_helper'
require 'digest'

# Boots the real BlobsController plus UploadSession / Complete / DownloadSession
# against the real provider interface (Blobs.storage_provider) backed by the
# in-memory adapter: objects "uploaded" by a spec are put into it directly,
# exactly as a presigned PUT would leave them. Nothing under test is mocked.
# spec/requests/api/v1/blobs_minio_spec.rb runs the same flow against real MinIO.
RSpec.describe 'Blobs API', type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:store) { InMemoryStorage.new }
  let(:user) { create(:user) }
  let(:vault) { create(:vault, owner: user) }
  let(:headers) { auth_headers_for(user) }
  let(:blob_id) { SecureRandom.uuid }
  let(:manifest_bytes) { "wrapped-file-key\x00\xff".b }
  let(:encrypted_manifest) { Base64.strict_encode64(manifest_bytes) }
  let(:part_size) { 1024 }

  before { Blobs.storage_provider = store }
  after { Blobs.storage_provider = nil }

  describe 'POST /api/v1/blobs/upload-session' do
    it 'rejects a session that omits encrypted_manifest' do
      expect { post_upload }.not_to change(Blob, :count)

      expect(response).to have_http_status(:unprocessable_content)
      expect(json['error']).to eq('invalid_request')
      expect(json['message']).to include('encrypted_manifest required')
      expect(Blob.find_by(id: blob_id)).to be_nil
    end

    it 'presigns every part with its exact size and stores the manifest bytes' do
      freeze_time do
        expect { post_upload(manifest: encrypted_manifest, part_count: 3, ciphertext_size: 2 * part_size + 500) }.to change(Blob, :count).by(1)

        expect(response).to have_http_status(:created)
        storage_key = "vaults/#{vault.id}/blobs/#{blob_id}"
        expect(json['blob_id']).to eq(blob_id)
        expect(json['storage_key']).to eq(storage_key)
        expect(json['resumed']).to be(false)
        expect(json['parts'].map { |p| p.slice('part_number', 'ciphertext_size', 'stored', 'object_key', 'url') }).to eq([
          { 'part_number' => 1, 'ciphertext_size' => 1024, 'stored' => false, 'object_key' => "#{storage_key}/part-00001",
            'url' => "https://s3.spec.test/put/#{storage_key}/part-00001?len=1024" },
          { 'part_number' => 2, 'ciphertext_size' => 1024, 'stored' => false, 'object_key' => "#{storage_key}/part-00002",
            'url' => "https://s3.spec.test/put/#{storage_key}/part-00002?len=1024" },
          { 'part_number' => 3, 'ciphertext_size' => 500, 'stored' => false, 'object_key' => "#{storage_key}/part-00003",
            'url' => "https://s3.spec.test/put/#{storage_key}/part-00003?len=500" }
        ])

        blob = Blob.find(blob_id)
        expect(blob.vault).to eq(vault)
        expect(blob.status).to eq('uploading')
        expect(blob.ciphertext_size).to eq(2548)
        expect(blob.upload_expires_at).to eq(24.hours.from_now)
        expect(blob.encrypted_manifest.unpack('C*')).to eq(manifest_bytes.unpack('C*'))
        expect(blob.blob_parts.order(:part_number).pluck(:part_number, :ciphertext_size)).to eq([[1, 1024], [2, 1024], [3, 500]])
      end
    end

    it 'does not open a session for another user\'s vault' do
      other_vault = create(:vault)
      expect { post_upload(manifest: encrypted_manifest, vault_id: other_vault.id) }.not_to change(Blob, :count)
      expect(response).to have_http_status(:not_found)
      expect(json['error']).to eq('not_found')
    end

    it 'rejects an unauthenticated upload' do
      post_upload(manifest: encrypted_manifest, hdrs: {})
      expect(response).to have_http_status(:unauthorized)
      expect(json['error']).to eq('unauthorized')
    end

    describe 'limits' do
      {
        'part_size above the 8 MiB part cap' => [{ part_count: 1, part_size: 8 * 1024 * 1024 + 1, ciphertext_size: 100 }, 'part_size must be between 1 and 8388608 bytes'],
        'a missing part_size' => [{ part_count: 1, part_size: nil, ciphertext_size: 100 }, 'part_size must be between 1 and 8388608 bytes'],
        'part_count above the cap' => [{ part_count: 5_121, part_size: 1024, ciphertext_size: 5_121 * 1024 }, 'part_count exceeds maximum 5120'],
        'ciphertext_size above the per-blob cap' => [{ part_count: 641, part_size: 8 * 1024 * 1024, ciphertext_size: 5 * 1024**3 + 1 }, 'ciphertext_size exceeds the per-blob maximum of 5368709120 bytes'],
        'a last part larger than part_size' => [{ part_count: 2, part_size: 1024, ciphertext_size: 2049 }, 'part_count and part_size do not match ciphertext_size'],
        'an empty last part' => [{ part_count: 3, part_size: 1024, ciphertext_size: 2048 }, 'part_count and part_size do not match ciphertext_size'],
        'a blob_id that is not a UUID' => [{ blob_id: 'not-a-uuid' }, 'blob_id must be a UUID']
      }.each do |what, (overrides, message)|
        it "rejects #{what} before creating anything" do
          expect { post_upload(manifest: encrypted_manifest, **overrides) }.not_to change(Blob, :count)
          expect(response).to have_http_status(:unprocessable_content)
          expect(json['message']).to include(message)
          expect(BlobPart.count).to eq(0)
        end
      end
    end

    describe 'quota' do
      before { stub_const('Billing::Quota::STORAGE_LIMIT_BYTES', 3_000) }

      it 'counts complete blobs and unexpired in-flight sessions, and refuses what does not fit' do
        seed_blob(status: 'complete', size: 2_000)
        seed_blob(status: 'uploading', size: 500, upload_expires_at: 1.hour.from_now)

        expect { post_upload(manifest: encrypted_manifest, part_count: 1, part_size: 600, ciphertext_size: 501) }.not_to change(Blob, :count)
        expect(response).to have_http_status(:unprocessable_content)
        expect(json['message']).to eq('storage quota exceeded')

        post_upload(manifest: encrypted_manifest, part_count: 1, part_size: 600, ciphertext_size: 500)
        expect(response).to have_http_status(:created)
      end

      it 'releases the reservation of an expired session at once' do
        seed_blob(status: 'complete', size: 2_000)
        seed_blob(status: 'uploading', size: 900, upload_expires_at: 1.minute.ago)

        post_upload(manifest: encrypted_manifest, part_count: 1, part_size: 1_000, ciphertext_size: 1_000)
        expect(response).to have_http_status(:created)
      end

      it 'counts only the owner\'s blobs' do
        seed_blob(status: 'complete', size: 2_900, vault: create(:vault))

        post_upload(manifest: encrypted_manifest, part_count: 1, part_size: 1_000, ciphertext_size: 1_000)
        expect(response).to have_http_status(:created)
      end
    end

    describe 'resume (same blob_id again)' do
      before { upload!(part_count: 3, ciphertext_size: 3 * part_size) }

      it 're-signs every part, extends the session and marks parts storage already holds at the exact size' do
        store.put(object_key(1), 'x' * part_size)
        store.put(object_key(2), 'x' * (part_size - 1)) # wrong size: must be sent again
        Blob.find(blob_id).update!(upload_expires_at: 1.hour.from_now) # session opened 23 h ago
        post_upload(manifest: encrypted_manifest, part_count: 3, ciphertext_size: 3 * part_size)

        expect(response).to have_http_status(:ok)
        expect(json['resumed']).to be(true)
        expect(json['parts'].map { |p| [p['part_number'], p['stored']] }).to eq([[1, true], [2, false], [3, false]])
        expect(json['parts'].map { |p| p['url'] }).to all(include('?len=1024'))
        expect(Blob.find(blob_id).upload_expires_at).to be_within(5.seconds).of(24.hours.from_now)
        expect(Blob.count).to eq(1)
        expect(BlobPart.count).to eq(3)
      end

      it 'refuses a different manifest or a different part layout' do
        post_upload(manifest: Base64.strict_encode64('other'), part_count: 3, ciphertext_size: 3 * part_size)
        expect(response).to have_http_status(:unprocessable_content)
        expect(json['message']).to eq('an upload session for this blob_id exists with a different manifest or part layout')

        post_upload(manifest: encrypted_manifest, part_count: 3, part_size: 1_100, ciphertext_size: 3 * part_size)
        expect(response).to have_http_status(:unprocessable_content)
        expect(json['message']).to eq('an upload session for this blob_id exists with a different manifest or part layout')
      end

      it 'refuses an expired session' do
        Blob.find(blob_id).update!(upload_expires_at: 1.minute.ago)
        post_upload(manifest: encrypted_manifest, part_count: 3, ciphertext_size: 3 * part_size)
        expect(response).to have_http_status(:unprocessable_content)
        expect(json['message']).to eq('upload session expired; start a new upload with a new blob_id')
      end

      it 'refuses a completed blob' do
        3.times { |i| store.put(object_key(i + 1), 'x' * part_size) }
        post_complete(parts: (1..3).map { |n| part_report(n) })
        expect(response).to have_http_status(:ok)

        post_upload(manifest: encrypted_manifest, part_count: 3, ciphertext_size: 3 * part_size)
        expect(response).to have_http_status(:unprocessable_content)
        expect(json['message']).to eq('blob is complete; start a new upload with a new blob_id')
      end

      it 'refuses a blob_id that belongs to another user without touching it' do
        other = create(:user)
        post '/api/v1/blobs/upload-session', params: upload_body(manifest: encrypted_manifest, part_count: 3, ciphertext_size: 3 * part_size,
                                                                 vault_id: create(:vault, owner: other).id),
                                             headers: auth_headers_for(other), as: :json
        expect(response).to have_http_status(:unprocessable_content)
        expect(json['message']).to eq('blob_id is already in use')
        expect(Blob.find(blob_id).vault).to eq(vault)
      end
    end
  end

  describe 'POST /api/v1/blobs/:id/complete' do
    it 'rejects a complete call that omits parts' do
      upload!
      post_complete
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['error']).to eq('invalid_request')
      expect(json['message']).to include('parts list required')
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 'rejects parts that do not match the stored part list' do
      upload!(part_count: 2, ciphertext_size: 2 * part_size)

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('parts count mismatch: expected 2, got 1')
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 'rejects a reported size that differs from the size the session declared' do
      upload!
      store.put(object_key(1), 'x' * part_size)

      post_complete(parts: [part_report(1, size: part_size - 1)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq("part 1 ciphertext_size #{part_size - 1} differs from the session's #{part_size}")
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 'rejects a part that is not in storage' do
      upload!(part_count: 2, ciphertext_size: 2 * part_size)
      store.put(object_key(1), 'x' * part_size)

      post_complete(parts: [part_report(1), part_report(2)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('part 2 not found in storage')
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 'rejects a part whose stored object has a different size' do
      upload!
      store.put(object_key(1), 'x' * (part_size + 1))

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq("part 1 size mismatch: storage has #{part_size + 1}, expected #{part_size}")
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 'rejects a malformed part hash' do
      upload!
      store.put(object_key(1), 'x' * part_size)

      post_complete(parts: [part_report(1).merge(ciphertext_sha256_b64: Base64.strict_encode64('short'))])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('part 1 ciphertext_sha256_b64 must be a SHA-256 (32 bytes)')
    end

    it 'marks the blob complete when every part is in storage at its exact size, then serves it for download' do
      upload!(part_count: 2, ciphertext_size: part_size + 10)
      store.put(object_key(1), 'x' * part_size)
      store.put(object_key(2), 'y' * 10)

      post_complete(parts: [part_report(2, size: 10), part_report(1)])
      expect(response).to have_http_status(:ok)
      expect(json['blob']).to eq('id' => blob_id, 'status' => 'complete', 'ciphertext_size' => part_size + 10)

      blob = Blob.find(blob_id)
      expect(blob.status).to eq('complete')
      expect(blob.upload_expires_at).to be_nil
      expect(blob.encrypted_manifest.unpack('C*')).to eq(manifest_bytes.unpack('C*'))

      get "/api/v1/blobs/#{blob_id}/download-session", headers: headers
      expect(response).to have_http_status(:ok)
      expect(json['encrypted_manifest']).to eq(encrypted_manifest)
      expect(json['status']).to eq('complete')
      expect(json['ciphertext_size']).to eq(part_size + 10)
      expect(json['parts'].map { |p| p.slice('part_number', 'ciphertext_size', 'url') }).to eq([
        { 'part_number' => 1, 'ciphertext_size' => part_size, 'url' => "https://s3.spec.test/get/#{object_key(1)}" },
        { 'part_number' => 2, 'ciphertext_size' => 10, 'url' => "https://s3.spec.test/get/#{object_key(2)}" }
      ])
    end

    it 'refuses to complete twice' do
      upload!
      store.put(object_key(1), 'x' * part_size)
      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:ok)

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('blob is not uploading')
    end

    it 'refuses an expired session even when every part is stored' do
      upload!
      store.put(object_key(1), 'x' * part_size)
      Blob.find(blob_id).update!(upload_expires_at: 1.minute.ago)
      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('upload session expired; start a new upload with a new blob_id')
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 're-checks the quota at complete (limit lowered while the upload was in flight)' do
      stub_const('Billing::Quota::STORAGE_LIMIT_BYTES', 3_000)
      seed_blob(status: 'complete', size: 1_500)
      upload!
      store.put(object_key(1), 'x' * part_size)

      stub_const('Billing::Quota::STORAGE_LIMIT_BYTES', 2_000)
      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('storage quota exceeded')
      expect(Blob.find(blob_id).status).to eq('uploading')
    end
  end

  describe 'GET /api/v1/blobs/:id/download-session' do
    it 'refuses a blob that is not complete' do
      upload!
      get "/api/v1/blobs/#{blob_id}/download-session", headers: headers
      expect(response).to have_http_status(:unprocessable_content)
      expect(json['message']).to eq('blob not complete')
    end
  end

  describe 'another user' do
    before { upload! }

    let(:other_headers) { auth_headers_for(create(:user)) }

    it 'cannot complete or download someone else\'s blob' do
      store.put(object_key(1), 'x' * part_size)
      post_complete(parts: [part_report(1)], hdrs: other_headers)
      expect(response).to have_http_status(:not_found)
      expect(json['error']).to eq('not_found')
      expect(Blob.find(blob_id).status).to eq('uploading')

      get "/api/v1/blobs/#{blob_id}/download-session", headers: other_headers
      expect(response).to have_http_status(:not_found)
      expect(json['error']).to eq('not_found')

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:ok)

      get "/api/v1/blobs/#{blob_id}/download-session", headers: other_headers
      expect(response).to have_http_status(:not_found)
      expect(json['error']).to eq('not_found')
      expect(Blob.find(blob_id).status).to eq('complete')
    end

    it 'gets no access through a share row (sharing grants no blob access yet)' do
      store.put(object_key(1), 'x' * part_size)
      post_complete(parts: [part_report(1)])
      recipient = create(:user)
      Share.create!(vault: vault, owner_id: user.id, recipient_id: recipient.id, status: 'active', permission: 'read')

      get "/api/v1/blobs/#{blob_id}/download-session", headers: auth_headers_for(recipient)
      expect(response).to have_http_status(:not_found)
    end
  end

  def object_key(n) = "vaults/#{vault.id}/blobs/#{blob_id}/part-#{format('%05d', n)}"

  def seed_blob(status:, size:, vault: self.vault, upload_expires_at: nil)
    Blob.create!(vault: vault, storage_key: "vaults/#{vault.id}/blobs/#{SecureRandom.uuid}", ciphertext_size: size,
                 status: status, encrypted_manifest: 'm', upload_expires_at: upload_expires_at)
  end

  def upload_body(manifest: :omit, part_count: 1, part_size: self.part_size, ciphertext_size: part_size, vault_id: vault.id, blob_id: self.blob_id)
    body = { vault_id: vault_id, blob_id: blob_id, part_count: part_count, part_size: part_size, ciphertext_size: ciphertext_size }
    body[:encrypted_manifest] = manifest unless manifest == :omit
    body
  end

  def post_upload(**kwargs)
    hdrs = kwargs.delete(:hdrs) || headers
    post '/api/v1/blobs/upload-session', params: upload_body(**kwargs), headers: hdrs, as: :json
  end

  def upload!(**kwargs)
    post_upload(manifest: encrypted_manifest, **kwargs)
    expect(response).to have_http_status(:created)
  end

  def post_complete(parts: :omit, hdrs: headers)
    body = {}
    body[:parts] = parts unless parts == :omit
    post "/api/v1/blobs/#{blob_id}/complete", params: body, headers: hdrs, as: :json
  end

  def part_report(number, size: part_size)
    {
      part_number: number,
      ciphertext_size: size,
      ciphertext_sha256_b64: Base64.strict_encode64(Digest::SHA256.digest("part-#{number}-#{size}"))
    }
  end

  def json
    JSON.parse(response.body)
  end
end
