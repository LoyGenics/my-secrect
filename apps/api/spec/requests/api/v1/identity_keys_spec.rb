require 'rails_helper'
require 'securerandom'

# Sharing identity keys (specs/sharing-protocol.md §3–4). Real rows, real
# session tokens; nothing in the Sharing domain is stubbed.
RSpec.describe 'Identity keys API', type: :request do
  let(:user) { create(:user, email: 'alice@example.test') }
  let(:headers) { auth_headers_for(user) }
  let(:public_key) { SecureRandom.random_bytes(32) }
  let(:encrypted_secret) { SecureRandom.random_bytes(120) }

  def b64(bytes) = Base64.strict_encode64(bytes)
  def json = JSON.parse(response.body)

  def register(pk: public_key, secret: encrypted_secret, as_headers: headers)
    put '/api/v1/identity-key', params: { public_key: b64(pk), encrypted_secret_key: b64(secret) }, headers: as_headers, as: :json
  end

  it 'requires a session for every endpoint' do
    get '/api/v1/identity-key'
    expect(response).to have_http_status(:unauthorized)
    put '/api/v1/identity-key', params: { public_key: b64(public_key), encrypted_secret_key: b64(encrypted_secret) }, as: :json
    expect(response).to have_http_status(:unauthorized)
    post '/api/v1/identity-keys/lookup', params: { email: user.email }, as: :json
    expect(response).to have_http_status(:unauthorized)
    expect(IdentityKey.count).to eq(0)
  end

  it 'returns 404 before registration, then stores raw bytes and returns them once-encoded' do
    get '/api/v1/identity-key', headers: headers
    expect(response).to have_http_status(:not_found)

    expect { register }.to change(IdentityKey, :count).by(1)
    expect(response).to have_http_status(:created)
    expect(json.fetch('identity_key')).to include(
      'user_id' => user.id, 'public_key' => b64(public_key), 'encrypted_secret_key' => b64(encrypted_secret)
    )
    stored = IdentityKey.find_by!(user_id: user.id)
    expect(stored.public_key.bytesize).to eq(32)
    expect(stored.public_key.b).to eq(public_key.b)
    expect(stored.encrypted_secret_key.b).to eq(encrypted_secret.b)
    expect(AuditEvent.where(user_id: user.id, event_type: 'identity_key_registered').count).to eq(1)

    get '/api/v1/identity-key', headers: headers
    expect(response).to have_http_status(:ok)
    expect(json.dig('identity_key', 'public_key')).to eq(b64(public_key))
    expect(json.dig('identity_key', 'encrypted_secret_key')).to eq(b64(encrypted_secret))
  end

  it 'is write-once: the same public key is idempotent, a different one is 409 and changes nothing' do
    register
    register(secret: SecureRandom.random_bytes(120))
    expect(response).to have_http_status(:ok)
    expect(IdentityKey.find_by!(user_id: user.id).encrypted_secret_key.b).to eq(encrypted_secret.b)

    register(pk: SecureRandom.random_bytes(32))
    expect(response).to have_http_status(:conflict)
    expect(json.fetch('error')).to eq('identity_key_exists')
    expect(IdentityKey.where(user_id: user.id).count).to eq(1)
    expect(IdentityKey.find_by!(user_id: user.id).public_key.b).to eq(public_key.b)
    expect(AuditEvent.where(user_id: user.id, event_type: 'identity_key_registered').count).to eq(1)
  end

  it 'rejects malformed keys with 422' do
    [
      { public_key: b64(SecureRandom.random_bytes(31)), encrypted_secret_key: b64(encrypted_secret) },
      { public_key: b64(SecureRandom.random_bytes(33)), encrypted_secret_key: b64(encrypted_secret) },
      { public_key: 'not base64!!', encrypted_secret_key: b64(encrypted_secret) },
      { public_key: b64(public_key), encrypted_secret_key: '' },
      { public_key: b64(public_key), encrypted_secret_key: b64(SecureRandom.random_bytes(10)) },
      { public_key: b64(public_key) }
    ].each do |params|
      put '/api/v1/identity-key', params: params, headers: headers, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json.fetch('error')).to eq('invalid_request')
    end
    expect(IdentityKey.count).to eq(0)
  end

  it "never returns another user's key from GET" do
    register
    other = create(:user)
    get '/api/v1/identity-key', headers: auth_headers_for(other)
    expect(response).to have_http_status(:not_found)
    expect(response.body).not_to include(b64(public_key))
  end

  describe 'lookup' do
    let(:other) { create(:user) }
    let(:other_headers) { auth_headers_for(other) }

    it 'returns the public key only, matching the email case-insensitively' do
      register
      post '/api/v1/identity-keys/lookup', params: { email: '  ALICE@example.test ' }, headers: other_headers, as: :json
      expect(response).to have_http_status(:ok)
      expect(json).to eq('user_id' => user.id, 'email' => 'alice@example.test', 'public_key' => b64(public_key))
      expect(response.body).not_to include(b64(encrypted_secret))
    end

    it 'returns 404 for an unknown email, a user without a key, or a suspended user' do
      post '/api/v1/identity-keys/lookup', params: { email: 'nobody@example.test' }, headers: other_headers, as: :json
      expect(response).to have_http_status(:not_found)

      post '/api/v1/identity-keys/lookup', params: { email: user.email }, headers: other_headers, as: :json
      expect(response).to have_http_status(:not_found)

      register
      user.update!(status: 'suspended')
      post '/api/v1/identity-keys/lookup', params: { email: user.email }, headers: other_headers, as: :json
      expect(response).to have_http_status(:not_found)
    end
  end
end
