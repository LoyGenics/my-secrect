require 'rails_helper'

# Storage LIFECYCLE only: asserts account deletion issues a delete_object
# for every blob part key, and fails loudly (no silent loss) otherwise.
# The S3 client is the AWS SDK's own stub client; this proves nothing about
# crypto or real MinIO behaviour (the compose smoke test covers real MinIO).
RSpec.describe 'Account deletion removes object-storage bytes', type: :request do
  let(:s3) { Aws::S3::Client.new(stub_responses: true, region: 'us-east-1', access_key_id: 'x', secret_access_key: 'y') }

  before { allow(Aws::S3::Client).to receive(:new).and_return(s3) }

  def stepped_up_token(user)
    device = create(:device, user: user)
    token = Authentication::SessionTokens.issue(user: user, device: device, user_agent: 'spec')
    Session.find_by!(token_digest: Digest::SHA256.hexdigest(token))
           .update!(step_up_verified_at: Time.current, step_up_method: 'passkey')
    token
  end

  def seed_blob(vault, status:, parts:)
    blob = Blob.create!(vault: vault, storage_key: "vaults/#{vault.id}/blobs/#{SecureRandom.uuid}",
                        ciphertext_size: 3, status: status, encrypted_manifest: 'm')
    (1..parts).map do |n|
      key = "#{blob.storage_key}/part-#{format('%05d', n)}"
      BlobPart.create!(blob: blob, part_number: n, object_key: key, ciphertext_size: 3)
      key
    end
  end

  def deleted_keys = s3.api_requests.select { |r| r[:operation_name] == :delete_object }.map { |r| r[:params][:key] }

  it 'deletes every part key of every blob (all statuses, all vaults) and nothing else' do
    user = create(:user)
    other = create(:user)
    v1 = create(:vault, owner: user)
    v2 = create(:vault, owner: user)
    ov = create(:vault, owner: other)
    mine = seed_blob(v1, status: 'complete', parts: 3) + seed_blob(v1, status: 'uploading', parts: 2) +
           seed_blob(v2, status: 'pending', parts: 1)
    bystander = seed_blob(ov, status: 'complete', parts: 2)
    token = stepped_up_token(user)

    delete '/api/v1/auth/account', headers: { 'Authorization' => "Bearer #{token}" }, as: :json

    expect(response).to have_http_status(:no_content)
    expect(deleted_keys).to match_array(mine)
    expect(deleted_keys & bystander).to be_empty
    expect(User.exists?(user.id)).to be(false)
    expect(BlobPart.where(object_key: bystander).count).to eq(2)
  end

  it 'does not delete the account and records an audit event when storage deletion fails' do
    user = create(:user)
    vault = create(:vault, owner: user)
    keys = seed_blob(vault, status: 'complete', parts: 2)
    token = stepped_up_token(user)
    s3.stub_responses(:delete_object, 'InternalError')

    delete '/api/v1/auth/account', headers: { 'Authorization' => "Bearer #{token}" }, as: :json

    expect(response).to have_http_status(:service_unavailable)
    expect(JSON.parse(response.body)['error']).to eq('storage_unavailable')
    expect(User.exists?(user.id)).to be(true)
    expect(BlobPart.where(object_key: keys).count).to eq(2)
    event = AuditEvent.where(user_id: user.id, event_type: 'account_deletion_storage_failed').last
    expect(event.metadata).to include('failed_objects' => 2, 'total_objects' => 2)
    expect(event.metadata.to_json).not_to include(keys.first)

    # Retry after storage recovers completes the deletion.
    s3.stub_responses(:delete_object, {})
    delete '/api/v1/auth/account', headers: { 'Authorization' => "Bearer #{token}" }, as: :json
    expect(response).to have_http_status(:no_content)
    expect(User.exists?(user.id)).to be(false)
  end
end
