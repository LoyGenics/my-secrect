require 'rails_helper'
require 'openssl'
require 'rbnacl'

# Recovery verifier key derivation (specs/recovery-protocol.md, "Recovery
# verifier key"): only v1 (HKDF-derived seed) may be registered, legacy v0
# verifiers keep signing users in until re-registered. Keys are real
# Ed25519 (RbNaCl); the v1 seed is derived here with OpenSSL's HKDF, an
# implementation independent of the TS client, and pinned to the spec vector.
RSpec.describe 'Recovery verifier derivation', type: :request do
  let(:user) { User.create!(email: "rv-#{SecureRandom.hex(4)}@example.test") }
  let(:recovery_key) { (0..31).to_a.pack('C*') }

  def json_body = JSON.parse(response.body)

  def stepped_up_headers
    token = Authentication::SessionTokens.issue(user: user, step_up_verified_at: Time.current, step_up_method: 'passkey')
    { 'Authorization' => "Bearer #{token}" }
  end

  def v1_signing_key(key_bytes)
    seed = OpenSSL::KDF.hkdf(key_bytes, salt: "\0" * 32, info: 'my-secrect/recovery-verifier/v1', length: 32, hash: 'SHA256')
    RbNaCl::SigningKey.new(seed)
  end

  def recovery_sign_in(signing_key)
    post '/api/v1/recovery/challenges', params: { email: user.email, kind: 'recovery_key' }, as: :json
    challenge = Authentication::SecretEncryptor.decode_base64_loose(json_body['challenge'])
    post '/api/v1/recovery/verify', params: { challenge_id: json_body['challenge_id'], email: user.email,
                                              signature: Base64.strict_encode64(signing_key.sign(challenge)) }, as: :json
    response.status
  end

  it 'derives the spec vector (OpenSSL HKDF == the TS client derivation)' do
    expect(Base64.urlsafe_encode64(v1_signing_key(recovery_key).verify_key.to_bytes, padding: false))
      .to eq('efL6ta1EHZPiP7pUhUjbWe9G_qoAvGa3FnfhRKdWtwM')
  end

  it 'refuses to register anything but the v1 derivation' do
    public_key = Base64.strict_encode64(v1_signing_key(recovery_key).verify_key.to_bytes)
    [nil, 'v0-raw-recovery-key', 'v2'].each do |derivation|
      post '/api/v1/recovery/verifiers', headers: stepped_up_headers,
                                         params: { public_key: public_key, derivation: derivation }.compact, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json_body).to eq('error' => 'unsupported_derivation')
    end
    expect(RecoveryVerifier.count).to eq(0)
  end

  it 'keeps a legacy v0 verifier working until re-registration replaces it with v1' do
    legacy_key = RbNaCl::SigningKey.new(recovery_key) # v0: seed = the recovery key itself
    user.recovery_verifiers.create!(public_key: Base64.strict_encode64(legacy_key.verify_key.to_bytes))
    expect(user.recovery_verifiers.last.derivation).to eq('v0-raw-recovery-key')
    expect(recovery_sign_in(v1_signing_key(recovery_key))).to eq(401) # what the client tries first
    expect(recovery_sign_in(legacy_key)).to eq(200)                   # its one fallback

    post '/api/v1/recovery/verifiers', headers: stepped_up_headers,
                                       params: { public_key: Base64.strict_encode64(v1_signing_key(recovery_key).verify_key.to_bytes),
                                                 derivation: 'v1-hkdf-sha256' }, as: :json
    expect(response).to have_http_status(:created)
    expect(json_body['verifier']['derivation']).to eq('v1-hkdf-sha256')
    get '/api/v1/recovery/verifiers', headers: stepped_up_headers, as: :json
    expect(json_body['verifiers'].map { |v| v['derivation'] }).to eq(['v1-hkdf-sha256'])

    expect(recovery_sign_in(legacy_key)).to eq(401)
    expect(recovery_sign_in(v1_signing_key(recovery_key))).to eq(200)
  end
end
