require 'rails_helper'
require 'webauthn/fake_client'

# Passkey verification specs — REAL WebAuthn, no stubs, no mocks.
#
# Credentials are produced by the `webauthn` gem's own FakeClient (a real
# ES256 authenticator: real attestation objects, real signatures over the
# server-issued challenge). The server side under test is the production
# code path: Authentication::Passkeys.verify -> WebAuthn::Credential
# .from_create/from_get(...).verify(...). A green run here means the
# server really verifies challenges, origin, RP ID, user presence /
# verification, signatures and sign counts — not that a shape check passed.
#
# Test relying party (from config/initializers/webauthn.rb defaults, no
# ENV overrides in test): origin http://localhost:3000, RP ID localhost.
# The FakeClient must use that origin or verification must fail.
RSpec.describe 'Passkeys API', type: :request do
  let(:origin) { 'http://localhost:3000' }
  let(:email) { 'passkey-user@example.test' }

  def json_body
    JSON.parse(response.body)
  end

  def b64url_decode(str)
    Base64.urlsafe_decode64(str + ('=' * ((4 - (str.length % 4)) % 4)))
  end

  def b64url_encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  # Step 1 (registration) through the real HTTP route.
  def registration_options_for(address)
    post '/api/v1/auth/passkeys/register', params: { email: address }, as: :json
    expect(response).to have_http_status(:ok)
    json_body
  end

  # Full registration ceremony through the real HTTP routes. Returns
  # [fake_client, credential_hash]. The fake client keeps the private key,
  # so the same client object must be reused for later assertions.
  def register_passkey(address: email, client: WebAuthn::FakeClient.new(origin))
    options = registration_options_for(address)
    credential = client.create(challenge: options['creation_options']['challenge'], user_verified: true)
    post '/api/v1/auth/passkeys/verify',
         params: { email: address, credential: credential, kind: 'registration' }, as: :json
    [client, credential]
  end

  # Step 1 (authentication) through the real HTTP route.
  def authentication_challenge_for(address)
    post '/api/v1/auth/passkeys/authenticate', params: { email: address }, as: :json
    expect(response).to have_http_status(:ok)
    json_body['request_options']['challenge']
  end

  def authenticate_passkey(address: email, client:, sign_count: nil, user_verified: true)
    challenge = authentication_challenge_for(address)
    allow = User.find_by(email: address)&.authenticators&.active&.pluck(:credential_id) || []
    assertion = client.get(
      challenge: challenge,
      sign_count: sign_count,
      user_verified: user_verified,
      allow_credentials: allow
    )
    post '/api/v1/auth/passkeys/verify',
         params: { email: address, credential: assertion, kind: 'authentication' }, as: :json
    assertion
  end

  describe 'POST /api/v1/auth/passkeys/verify (registration)' do
    it 'accepts a valid attestation, persists the authenticator, and issues a token' do
      client, credential = register_passkey
      expect(response).to have_http_status(:ok)
      expect(json_body['token']).to start_with('sess_')
      expect(json_body['user_id']).to be_present
      expect(json_body['device_id']).to be_present

      authenticator = Authenticator.last
      expect(authenticator.credential_id).to eq(credential['id'])
      expect(authenticator.public_key).to be_present
      expect(authenticator.sign_count).to eq(0)
      expect(authenticator.user.email).to eq(email)
    end

    it 'rejects a credential created for the wrong origin' do
      options = registration_options_for(email)
      evil_client = WebAuthn::FakeClient.new('https://evil.example')
      # rp_id kept at localhost so ONLY the origin check can fail.
      credential = evil_client.create(challenge: options['creation_options']['challenge'], rp_id: 'localhost', user_verified: true)
      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: credential, kind: 'registration' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(json_body['error']).to eq('verification_failed')
      expect(Authenticator.count).to eq(0)
    end

    it 'rejects a credential created for the wrong RP ID' do
      options = registration_options_for(email)
      client = WebAuthn::FakeClient.new(origin)
      credential = client.create(challenge: options['creation_options']['challenge'], rp_id: 'evil.test', user_verified: true)
      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: credential, kind: 'registration' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(Authenticator.count).to eq(0)
    end

    it 'rejects a reused challenge (same credential posted twice)' do
      _client, credential = register_passkey
      expect(response).to have_http_status(:ok)
      expect(Authenticator.count).to eq(1)

      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: credential, kind: 'registration' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(Authenticator.count).to eq(1)
      expect(Session.count).to eq(1) # no second session was issued
    end

    it 'rejects a second passkey for an account that already has one (takeover guard)' do
      register_passkey
      expect(response).to have_http_status(:ok)

      other_client = WebAuthn::FakeClient.new(origin)
      options = registration_options_for(email)
      credential = other_client.create(challenge: options['creation_options']['challenge'], user_verified: true)
      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: credential, kind: 'registration' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(Authenticator.count).to eq(1)
    end

    it 'rejects a credential without user verification' do
      options = registration_options_for(email)
      client = WebAuthn::FakeClient.new(origin)
      credential = client.create(challenge: options['creation_options']['challenge'], user_verified: false)
      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: credential, kind: 'registration' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(Authenticator.count).to eq(0)
    end
  end

  describe 'POST /api/v1/auth/passkeys/verify (authentication)' do
    it 'accepts a valid assertion and advances the stored sign count' do
      client, _credential = register_passkey
      expect(Authenticator.last.sign_count).to eq(0)

      authenticate_passkey(client: client)
      expect(response).to have_http_status(:ok)
      expect(json_body['token']).to start_with('sess_')
      expect(Authenticator.last.sign_count).to eq(1)
    end

    it 'verifies the exact HTTP-issued challenge when another challenge is live' do
      client, _credential = register_passkey
      authentication_challenge_for(email)

      authenticate_passkey(client: client)

      expect(response).to have_http_status(:ok)
      expect(json_body['token']).to start_with('sess_')
      expect(PasskeyChallenge.live.where(email: email, kind: 'authentication').count).to eq(1)
    end

    it 'rejects a replayed assertion (same sign count as stored)' do
      client, _credential = register_passkey
      authenticate_passkey(client: client)
      expect(response).to have_http_status(:ok)
      expect(Authenticator.last.sign_count).to eq(1)
      sessions_before = Session.count

      # A fresh challenge and a valid signature — but the authenticator
      # data still claims sign_count 1, which did not increase. Only the
      # sign-count check can reject this.
      authenticate_passkey(client: client, sign_count: 1)
      expect(response).to have_http_status(:unauthorized)
      expect(Authenticator.last.sign_count).to eq(1)
      expect(Session.count).to eq(sessions_before)
    end

    it 'rejects a tampered signature' do
      client, _credential = register_passkey
      challenge = authentication_challenge_for(email)
      assertion = client.get(challenge: challenge, user_verified: true)
      tampered = b64url_decode(assertion['response']['signature']).bytes
      tampered[0] ^= 0xff
      assertion['response']['signature'] = b64url_encode(tampered.pack('C*'))

      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: assertion, kind: 'authentication' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(Authenticator.last.sign_count).to eq(0)
    end

    it 'rejects a valid assertion posted for a different account' do
      client, _credential = register_passkey
      expect(response).to have_http_status(:ok)

      # A real assertion, correctly signed over a fresh challenge for the
      # other email — but the credential belongs to the first account.
      # Lookup is scoped to the account, so this must fail generically.
      other_email = 'other-user@example.test'
      challenge = authentication_challenge_for(other_email)
      assertion = client.get(challenge: challenge, user_verified: true)
      post '/api/v1/auth/passkeys/verify',
           params: { email: other_email, credential: assertion, kind: 'authentication' }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end

    it 'rejects a reused authentication challenge' do
      client, _credential = register_passkey
      assertion = authenticate_passkey(client: client)
      expect(response).to have_http_status(:ok)

      post '/api/v1/auth/passkeys/verify',
           params: { email: email, credential: assertion, kind: 'authentication' }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end
  end
end
