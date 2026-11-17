require 'rails_helper'
require 'digest'

# Boots the real BlobsController plus UploadSession / Complete / DownloadSession.
# The only double is StorageProvider#head (the object-storage HEAD). Presign
# runs for real: it signs locally and does not contact S3/MinIO.
RSpec.describe 'Blobs API', type: :request do
  let(:user) { create(:user) }
  let(:vault) { create(:vault, owner: user) }
  let(:headers) { auth_headers_for(user) }
  let(:blob_id) { SecureRandom.uuid }
  let(:manifest_bytes) { "wrapped-file-key\x00\xff".b }
  let(:encrypted_manifest) { Base64.strict_encode64(manifest_bytes) }
  let(:part_size) { 1024 }
  let(:head_response) { Struct.new(:content_length).new(part_size) }

  before do
    allow_any_instance_of(Blobs::StorageProvider).to receive(:head).and_return(head_response)
  end

  describe 'POST /api/v1/blobs/upload-session' do
    it 'rejects a session that omits encrypted_manifest' do
      expect { post_upload }.not_to change(Blob, :count)

      expect(response).to have_http_status(:unprocessable_entity)
      expect(json['error']).to eq('invalid_request')
      expect(json['message']).to include('encrypted_manifest required')
      expect(Blob.find_by(id: blob_id)).to be_nil
    end

    it 'presigns and stores the manifest bytes when encrypted_manifest is valid' do
      expect { post_upload(manifest: encrypted_manifest) }.to change(Blob, :count).by(1)

      expect(response).to have_http_status(:created)
      body = json
      object_key = "vaults/#{vault.id}/blobs/#{blob_id}/part-00001"
      expect(body['blob_id']).to eq(blob_id)
      expect(body['storage_key']).to eq("vaults/#{vault.id}/blobs/#{blob_id}")
      expect(body['parts'].size).to eq(1)
      expect(body['parts'][0]['part_number']).to eq(1)
      expect(body['parts'][0]['object_key']).to eq(object_key)
      expect(body['parts'][0]['url']).to include('part-00001')
      expect(body['parts'][0]['url']).to include('X-Amz-Signature')
      expect(body['parts'][0]['expires_at']).to be_present

      blob = Blob.find(blob_id)
      expect(blob.vault).to eq(vault)
      expect(blob.status).to eq('uploading')
      expect(blob.ciphertext_size).to eq(part_size)
      expect(blob.encrypted_manifest.unpack('C*')).to eq(manifest_bytes.unpack('C*'))
      expect(blob.blob_parts.pluck(:part_number, :object_key, :ciphertext_size)).to eq([[1, object_key, 0]])
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
  end

  describe 'POST /api/v1/blobs/:id/complete' do
    it 'rejects a complete call that omits parts' do
      upload!
      post_complete
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json['error']).to eq('invalid_request')
      expect(json['message']).to include('parts list required')
      expect(Blob.find(blob_id).status).to eq('uploading')
    end

    it 'rejects parts that do not match the stored part list' do
      upload!(part_count: 2)

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json['message']).to include('parts count mismatch')
      expect(json['message']).to include('expected 2, got 1')
      blob = Blob.find(blob_id)
      expect(blob.status).to eq('uploading')
      expect(blob.blob_parts.order(:part_number).pluck(:ciphertext_size)).to eq([0, 0])
    end

    it 'rejects parts whose sizes do not match the object in storage' do
      upload!
      head_response.content_length = part_size + 1

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json['message']).to include('size mismatch')
      expect(json['message']).to include("storage has #{part_size + 1}")
      expect(json['message']).to include("client reported #{part_size}")
      blob = Blob.find(blob_id)
      expect(blob.status).to eq('uploading')
      expect(blob.blob_parts.first.ciphertext_size).to eq(0)
    end

    it 'marks the blob complete when parts match the stubbed object sizes' do
      upload!
      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:ok)
      expect(json['blob']).to include('id' => blob_id, 'status' => 'complete', 'ciphertext_size' => part_size)

      blob = Blob.find(blob_id)
      expect(blob.status).to eq('complete')
      expect(blob.ciphertext_size).to eq(part_size)
      expect(blob.blob_parts.first.ciphertext_size).to eq(part_size)
      expect(blob.encrypted_manifest.unpack('C*')).to eq(manifest_bytes.unpack('C*'))

      get "/api/v1/blobs/#{blob_id}/download-session", headers: headers
      expect(response).to have_http_status(:ok)
      download = json
      expect(download['encrypted_manifest']).to eq(encrypted_manifest)
      expect(download['status']).to eq('complete')
      expect(download['ciphertext_size']).to eq(part_size)
      expect(download['parts'][0]['url']).to include('X-Amz-Signature')
      expect(download['parts'][0]['url']).to include('part-00001')
      expect(download['parts'][0]['ciphertext_size']).to eq(part_size)
    end
  end

  describe 'another user' do
    before { upload! }

    let(:other_headers) { auth_headers_for(create(:user)) }

    it 'cannot complete or download someone else\'s blob' do
      post_complete(parts: [part_report(1)], hdrs: other_headers)
      expect(response).to have_http_status(:not_found)
      expect(json['error']).to eq('not_found')
      expect(Blob.find(blob_id).status).to eq('uploading')

      get "/api/v1/blobs/#{blob_id}/download-session", headers: other_headers
      expect(response).to have_http_status(:not_found)
      expect(json['error']).to eq('not_found')

      post_complete(parts: [part_report(1)])
      expect(response).to have_http_status(:ok)

      post_complete(parts: [part_report(1)], hdrs: other_headers)
      expect(response).to have_http_status(:not_found)
      get "/api/v1/blobs/#{blob_id}/download-session", headers: other_headers
      expect(response).to have_http_status(:not_found)
      expect(Blob.find(blob_id).status).to eq('complete')
      expect(Blob.find(blob_id).vault.owner).to eq(user)
    end
  end

  def upload_body(manifest: :omit, part_count: 1, ciphertext_size: part_size, vault_id: vault.id)
    body = { vault_id: vault_id, blob_id: blob_id, part_count: part_count, ciphertext_size: ciphertext_size }
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
