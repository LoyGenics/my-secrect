require 'rails_helper'
require 'net/http'

# The blob API against REAL MinIO — no adapter, no stub client: real SigV4
# presigned PUT/GET over HTTP, real ListObjectsV2 at complete and resume,
# real deletes in the cleanup job. Skipped unless MINIO_SPEC_ENDPOINT is set;
# run it with tests/media-e2e/rspec-minio.sh (throwaway MinIO container).
RSpec.describe 'Blobs API against real MinIO', type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:minio_env) do
    { 'S3_ENDPOINT' => ENV['MINIO_SPEC_ENDPOINT'], 'S3_PUBLIC_ENDPOINT' => ENV['MINIO_SPEC_ENDPOINT'], 'S3_REGION' => 'us-east-1',
      'S3_BUCKET' => ENV['MINIO_SPEC_BUCKET'], 'S3_ACCESS_KEY' => ENV['MINIO_SPEC_ACCESS_KEY'], 'S3_SECRET_KEY' => ENV['MINIO_SPEC_SECRET_KEY'] }
  end
  let(:raw) do
    Aws::S3::Client.new(endpoint: minio_env['S3_ENDPOINT'], force_path_style: true, region: 'us-east-1', stub_responses: false,
                        access_key_id: minio_env['S3_ACCESS_KEY'], secret_access_key: minio_env['S3_SECRET_KEY'])
  end
  let(:bucket) { minio_env['S3_BUCKET'] }
  let(:user) { create(:user) }
  let(:vault) { create(:vault, owner: user) }
  let(:headers) { auth_headers_for(user) }
  let(:blob_id) { SecureRandom.uuid }
  let(:manifest) { Base64.strict_encode64(SecureRandom.random_bytes(80)) }

  around do |example|
    next example.run if ENV['MINIO_SPEC_ENDPOINT'].blank?

    Aws.config.update(stub_responses: false)
    Blobs.storage_provider = Blobs::StorageProvider.new(env: minio_env)
    example.run
  ensure
    Blobs.storage_provider = nil
    Aws.config.update(stub_responses: true)
  end

  before do
    skip 'needs MINIO_SPEC_ENDPOINT: run tests/media-e2e/rspec-minio.sh' if ENV['MINIO_SPEC_ENDPOINT'].blank?
    begin
      raw.create_bucket(bucket: bucket)
    rescue Aws::S3::Errors::BucketAlreadyOwnedByYou
      nil
    end
    raw.list_objects_v2(bucket: bucket).flat_map { |page| page.contents.map(&:key) }.each { |k| raw.delete_object(bucket: bucket, key: k) }
  end

  it 'stores and serves ciphertext through real presigned URLs; storage refuses a part of any other length' do
    session = open_session(part_count: 3, part_size: 1024, ciphertext_size: 2 * 1024 + 300)
    parts = [SecureRandom.random_bytes(1024), SecureRandom.random_bytes(1024), SecureRandom.random_bytes(300)]

    oversized = http_put(session['parts'][2]['url'], SecureRandom.random_bytes(301))
    expect(oversized.code).to eq('403')
    expect(oversized.body).to include('SignatureDoesNotMatch')
    session['parts'].each_with_index { |p, i| expect(http_put(p['url'], parts[i]).code).to eq('200') }

    post "/api/v1/blobs/#{blob_id}/complete", params: { parts: reports(parts) }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
    expect(JSON.parse(response.body)['blob']).to eq('id' => blob_id, 'status' => 'complete', 'ciphertext_size' => 2348)

    get "/api/v1/blobs/#{blob_id}/download-session", headers: headers
    download = JSON.parse(response.body)
    expect(download['encrypted_manifest']).to eq(manifest)
    expect(download['parts'].map { |p| Net::HTTP.get_response(URI(p['url'])).body.b }).to eq(parts)
  end

  it 'refuses complete while a part is missing from storage; resume reports exactly what MinIO holds' do
    session = open_session(part_count: 3, part_size: 1024, ciphertext_size: 3 * 1024)
    parts = Array.new(3) { SecureRandom.random_bytes(1024) }
    http_put(session['parts'][0]['url'], parts[0])
    http_put(session['parts'][2]['url'], parts[2])

    post "/api/v1/blobs/#{blob_id}/complete", params: { parts: reports(parts) }, headers: headers, as: :json
    expect(response).to have_http_status(:unprocessable_content)
    expect(JSON.parse(response.body)['message']).to eq('part 2 not found in storage')

    resumed = open_session(part_count: 3, part_size: 1024, ciphertext_size: 3 * 1024, status: :ok)
    expect(resumed['resumed']).to be(true)
    expect(resumed['parts'].map { |p| p['stored'] }).to eq([true, false, true])
    expect(http_put(resumed['parts'][1]['url'], parts[1]).code).to eq('200')

    post "/api/v1/blobs/#{blob_id}/complete", params: { parts: reports(parts) }, headers: headers, as: :json
    expect(response).to have_http_status(:ok)
  end

  it 'cleanup job deletes an expired session\'s objects and orphan objects from real MinIO' do
    session = open_session(part_count: 2, part_size: 1024, ciphertext_size: 2048)
    session['parts'].each { |p| http_put(p['url'], SecureRandom.random_bytes(1024)) }
    Blob.find(blob_id).update!(upload_expires_at: 1.minute.ago)
    orphan = "vaults/#{vault.id}/blobs/#{SecureRandom.uuid}/part-00001"
    raw.put_object(bucket: bucket, key: orphan, body: 'leftover ciphertext')

    result = travel(10.minutes) { OrphanBlobCleanupJob.new.perform }

    expect(result).to eq(expired_blobs: 1, deleted_keys: 2, orphan_objects: 1)
    expect(raw.list_objects_v2(bucket: bucket).contents).to be_empty
    expect(Blob.exists?(blob_id)).to be(false)
  end

  def open_session(part_count:, part_size:, ciphertext_size:, status: :created)
    post '/api/v1/blobs/upload-session',
         params: { vault_id: vault.id, blob_id: blob_id, part_count: part_count, part_size: part_size,
                   ciphertext_size: ciphertext_size, encrypted_manifest: manifest },
         headers: headers, as: :json
    expect(response).to have_http_status(status)
    JSON.parse(response.body)
  end

  def http_put(url, body)
    uri = URI(url)
    Net::HTTP.start(uri.host, uri.port) { |h| h.request(Net::HTTP::Put.new(uri, 'Content-Type' => 'application/octet-stream').tap { |r| r.body = body }) }
  end

  def reports(parts)
    parts.each_with_index.map do |bytes, i|
      { part_number: i + 1, ciphertext_size: bytes.bytesize, ciphertext_sha256_b64: Base64.strict_encode64(Digest::SHA256.digest(bytes)) }
    end
  end
end
