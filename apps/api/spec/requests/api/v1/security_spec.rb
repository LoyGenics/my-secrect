require 'rails_helper'
require 'webauthn/fake_client'
require 'rotp'
require 'rbnacl'
require 'securerandom'
require 'digest'

# Security specs — MFA (real ROTP codes), step-up (real WebAuthn
# assertions via FakeClient), recovery (real Ed25519 signatures via
# RbNaCl), sessions, devices, activity. No mocks of the crypto: TOTP
# codes come from ROTP::TOTP over the secret the API itself issued,
# passkey assertions come from the `webauthn` gem's FakeClient, and
# recovery proofs are real RbNaCl signatures over the stored challenge.
#
# Timing note: a TOTP code for the CURRENT step may already have been
# consumed by confirm, so second-factor logins below use the code for
# the NEXT step (ROTP#at(Time.now + 30)) — the server accepts it via
# its ±1-step drift, and its step is strictly newer, so no replay.
RSpec.describe 'Security API', type: :request do
  let(:origin) { 'http://localhost:3000' }

  def json_body = JSON.parse(response.body)
  def auth_headers(token) = { 'Authorization' => "Bearer #{token}" }
  def fresh_email = "sec-#{SecureRandom.hex(6)}@example.test"

  def b64url_decode(str)
    Base64.urlsafe_decode64(str + ('=' * ((4 - (str.length % 4)) % 4)))
  end

  # Full registration ceremony through the real HTTP routes.
  def register_passkey(address:, client: WebAuthn::FakeClient.new(origin))
    options = registration_options_via_api(address)
    credential = client.create(challenge: options['creation_options']['challenge'], user_verified: true)
    post '/api/v1/auth/passkeys/verify',
         params: { email: address, credential: credential, kind: 'registration' }, as: :json
    expect(response).to have_http_status(:ok)
    [client, json_body['token']]
  end

  # Full login through the authenticate route. Returns the response body:
  # { 'token' => ... } or { 'mfa_required' => true, 'mfa_token' => ... }.
  def login_passkey(address:, client:)
    post '/api/v1/auth/passkeys/authenticate', params: { email: address }, as: :json
    expect(response).to have_http_status(:ok)
    challenge = json_body['request_options']['challenge']
    allow = User.find_by(email: address)&.authenticators&.active&.pluck(:credential_id) || []
    assertion = client.get(challenge: challenge, user_verified: true, allow_credentials: allow)
    post '/api/v1/auth/passkeys/verify',
         params: { email: address, credential: assertion, kind: 'authentication' }, as: :json
    expect(response).to have_http_status(:ok)
    json_body
  end

  def login_token(address:, client:)
    body = login_passkey(address: address, client: client)
    expect(body['token']).to start_with('sess_')
    body['token']
  end

  def step_up_with_passkey(token, address:, client:)
    post '/api/v1/auth/step-up/passkey/options', headers: auth_headers(token), as: :json
    expect(response).to have_http_status(:ok)
    challenge = json_body['request_options']['challenge']
    allow = User.find_by(email: address)&.authenticators&.active&.pluck(:credential_id) || []
    assertion = client.get(challenge: challenge, user_verified: true, allow_credentials: allow)
    post '/api/v1/auth/step-up/passkey', headers: auth_headers(token), params: { credential: assertion }, as: :json
    expect(response).to have_http_status(:ok)
    expect(json_body['step_up_verified']).to be(true)
  end

  # Enrol + confirm MFA. Returns { secret:, recovery_codes:, token: }
  # where token is the ROTATED session token from confirm.
  def enroll_and_confirm_mfa(token)
    post '/api/v1/auth/mfa/enroll', headers: auth_headers(token), as: :json
    expect(response).to have_http_status(:ok)
    secret = json_body['secret']
    expect(json_body['otpauth_url']).to start_with('otpauth://totp/')
    post '/api/v1/auth/mfa/confirm', headers: auth_headers(token),
         params: { code: ROTP::TOTP.new(secret).now }, as: :json
    expect(response).to have_http_status(:ok)
    expect(json_body['mfa_enabled']).to be(true)
    expect(json_body['recovery_codes'].length).to eq(10)
    expect(json_body['rotated_token']).to start_with('sess_')
    { secret: secret, recovery_codes: json_body['recovery_codes'], token: json_body['rotated_token'] }
  end

  def next_step_code(secret)
    ROTP::TOTP.new(secret).at(Time.now + 30)
  end

  def wrong_totp_code(secret)
    format('%06d', (ROTP::TOTP.new(secret).now.to_i + 1) % 1_000_000)
  end

  def step_up_with_totp(token, secret)
    post '/api/v1/auth/step-up/totp', headers: auth_headers(token),
         params: { code: next_step_code(secret) }, as: :json
    expect(response).to have_http_status(:ok)
    expect(json_body['step_up_verified']).to be(true)
  end

  describe 'POST /api/v1/auth/passkeys/authenticate' do
    it 'returns request options and a login via the route issues a token' do
      email = fresh_email
      client, _token = register_passkey(address: email)
      post '/api/v1/auth/passkeys/authenticate', params: { email: email }, as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['request_options']['challenge']).to be_present
      expect(json_body['request_options']['allowCredentials'].length).to eq(1)
      expect(login_token(address: email, client: client)).to start_with('sess_')
    end

    it 'does not leak account existence for unknown emails' do
      post '/api/v1/auth/passkeys/authenticate', params: { email: 'ghost@example.test' }, as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['request_options']['challenge']).to be_present
      expect(json_body['request_options']['allowCredentials']).to eq([])
    end
  end

  describe 'authenticated add-passkey flow' do
    it 'adds a second passkey, rotates the token, and the old token dies' do
      email = fresh_email
      client, token = register_passkey(address: email)
      step_up_with_passkey(token, address: email, client: client)
      post '/api/v1/auth/passkeys/add/options', headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:ok)
      other = WebAuthn::FakeClient.new(origin)
      credential = other.create(challenge: json_body['creation_options']['challenge'], user_verified: true)
      post '/api/v1/auth/passkeys/add/verify', headers: auth_headers(token),
           params: { credential: credential }, as: :json
      expect(response).to have_http_status(:created)
      expect(json_body['passkey']['credential_id_prefix']).to be_present
      expect(json_body['rotated_token']).to start_with('sess_')
      rotated = json_body['rotated_token']
      expect(Authenticator.count).to eq(2)
      get '/api/v1/auth/passkeys', headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:unauthorized)
      get '/api/v1/auth/passkeys', headers: auth_headers(rotated), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['passkeys'].length).to eq(2)
    end

    it 'lists passkeys with a credential prefix, not the full id' do
      email = fresh_email
      _client, token = register_passkey(address: email)
      get '/api/v1/auth/passkeys', headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:ok)
      entry = json_body['passkeys'].first
      expect(entry['credential_id_prefix'].length).to eq(12)
      expect(entry['sign_count']).to eq(0)
      expect(entry).to have_key('revoked_at')
    end

    it 'rejects unauthenticated add-options with 401 and un-stepped-up with 403' do
      email = fresh_email
      client, _token = register_passkey(address: email)
      post '/api/v1/auth/passkeys/add/options', as: :json
      expect(response).to have_http_status(:unauthorized)
      fresh_token = login_token(address: email, client: client)
      post '/api/v1/auth/passkeys/add/options', headers: auth_headers(fresh_token), as: :json
      expect(response).to have_http_status(:forbidden)
      expect(json_body['error']).to eq('step_up_required')
    end

    it 'refuses to remove the last passkey while MFA is disabled, allows it with MFA' do
      email = fresh_email
      client, token = register_passkey(address: email)
      step_up_with_passkey(token, address: email, client: client)
      passkey_id = Authenticator.last.id
      delete "/api/v1/auth/passkeys/#{passkey_id}", headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json_body['error']).to eq('last_authenticator')
      expect(Authenticator.last.revoked_at).to be_nil

      mfa = enroll_and_confirm_mfa(token)
      step_up_with_totp(mfa[:token], mfa[:secret])
      delete "/api/v1/auth/passkeys/#{passkey_id}", headers: auth_headers(mfa[:token]), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['rotated_token']).to start_with('sess_')
      expect(Authenticator.last.revoked_at).to be_present
    end
  end

  describe 'MFA (TOTP + recovery codes)' do
    it 'enrols, confirms, and stores only ciphertext (never the secret)' do
      email = fresh_email
      _client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      user = User.find_by(email: email)
      expect(user.mfa_enabled?).to be(true)
      expect(user.totp_secret_ciphertext).to be_present
      expect(user.totp_secret_ciphertext).not_to include(mfa[:secret])
      expect(Authentication::Totp.decrypt_secret(user.totp_secret_ciphertext)).to eq(mfa[:secret])
      expect(RecoveryCode.where(user: user).count).to eq(10)
      expect(RecoveryCode.where(user: user).pluck(:code_digest)).not_to include(*mfa[:recovery_codes])
    end

    it 'rejects a wrong confirm code with 401' do
      email = fresh_email
      _client, token = register_passkey(address: email)
      post '/api/v1/auth/mfa/enroll', headers: auth_headers(token), as: :json
      secret = json_body['secret']
      post '/api/v1/auth/mfa/confirm', headers: auth_headers(token),
           params: { code: wrong_totp_code(secret) }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(User.find_by(email: email).mfa_enabled?).to be(false)
    end

    it 'requires MFA at login, accepts the second factor, rejects a wrong one' do
      email = fresh_email
      client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      body = login_passkey(address: email, client: client)
      expect(body['mfa_required']).to be(true)
      expect(body['mfa_token']).to start_with('mfa_')
      expect(body['token']).to be_nil
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: wrong_totp_code(mfa[:secret]) }, as: :json
      expect(response).to have_http_status(:unauthorized)
      # The token burned on the failed attempt: reuse must fail too.
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: next_step_code(mfa[:secret]) }, as: :json
      expect(response).to have_http_status(:unauthorized)
      body2 = login_passkey(address: email, client: client)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body2['mfa_token'], code: next_step_code(mfa[:secret]) }, as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['token']).to start_with('sess_')
    end

    it 'rejects a replayed TOTP code at the second factor' do
      email = fresh_email
      client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      code = next_step_code(mfa[:secret])
      body = login_passkey(address: email, client: client)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: code }, as: :json
      expect(response).to have_http_status(:ok)
      body2 = login_passkey(address: email, client: client)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body2['mfa_token'], code: code }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end

    it 'accepts a recovery code once, then rejects it' do
      email = fresh_email
      client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      code = mfa[:recovery_codes].first
      body = login_passkey(address: email, client: client)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: code }, as: :json
      expect(response).to have_http_status(:ok)
      expect(AuditEvent.where(event_type: 'mfa_recovery_code_used').count).to eq(1)
      body2 = login_passkey(address: email, client: client)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body2['mfa_token'], code: code }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end

    it 'refuses MFA disable without step-up, allows it after step-up' do
      email = fresh_email
      client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      body = login_passkey(address: email, client: client)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: next_step_code(mfa[:secret]) }, as: :json
      fresh_token = json_body['token']
      post '/api/v1/auth/mfa/disable', headers: auth_headers(fresh_token), as: :json
      expect(response).to have_http_status(:forbidden)
      expect(json_body['error']).to eq('step_up_required')
      # Step up with the passkey, not TOTP: the MFA login just consumed
      # the current TOTP step, so a TOTP step-up here would replay.
      step_up_with_passkey(fresh_token, address: email, client: client)
      post '/api/v1/auth/mfa/disable', headers: auth_headers(fresh_token), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['rotated_token']).to start_with('sess_')
      user = User.find_by(email: email)
      expect(user.mfa_enabled?).to be(false)
      expect(user.totp_secret_ciphertext).to be_nil
      expect(RecoveryCode.where(user: user).count).to eq(0)
    end

    it 'regenerates recovery codes only with step-up, replacing the old ones' do
      email = fresh_email
      _client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      old_digests = RecoveryCode.where(user: User.find_by(email: email)).pluck(:code_digest)
      post '/api/v1/auth/mfa/recovery_codes', headers: auth_headers(mfa[:token]), as: :json
      expect(response).to have_http_status(:forbidden)
      step_up_with_totp(mfa[:token], mfa[:secret])
      post '/api/v1/auth/mfa/recovery_codes', headers: auth_headers(mfa[:token]), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['recovery_codes'].length).to eq(10)
      expect(RecoveryCode.where(user: User.find_by(email: email)).pluck(:code_digest) & old_digests).to eq([])
    end
  end
  describe 'step-up' do
    it 'expires after the 10-minute window' do
      email = fresh_email
      client, token = register_passkey(address: email)
      step_up_with_passkey(token, address: email, client: client)
      session_id = Session.live.find_by(user: User.find_by(email: email)).id
      Session.find(session_id).update!(step_up_verified_at: 11.minutes.ago)
      delete '/api/v1/auth/sessions/others', headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:forbidden)
      expect(json_body['error']).to eq('step_up_required')
    end

    it 'audits a failed step-up attempt without the code' do
      email = fresh_email
      _client, token = register_passkey(address: email)
      mfa = enroll_and_confirm_mfa(token)
      post '/api/v1/auth/step-up/totp', headers: auth_headers(mfa[:token]),
           params: { code: wrong_totp_code(mfa[:secret]) }, as: :json
      expect(response).to have_http_status(:unauthorized)
      event = AuditEvent.where(event_type: 'step_up_failed').last
      expect(event).to be_present
      expect(event.metadata).to eq({ 'method' => 'totp' })
    end
  end

  describe 'sessions' do
    it 'lists sessions with a current flag, revokes one, revoke-others keeps current' do
      email = fresh_email
      client, token_a = register_passkey(address: email)
      token_b = login_token(address: email, client: client)
      get '/api/v1/auth/sessions', headers: auth_headers(token_a), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['sessions'].length).to eq(2)
      other = json_body['sessions'].find { |s| !s['current'] }
      expect(other).to be_present
      delete "/api/v1/auth/sessions/#{other['id']}", headers: auth_headers(token_a), as: :json
      expect(response).to have_http_status(:no_content)
      get '/api/v1/auth/sessions', headers: auth_headers(token_a), as: :json
      expect(json_body['sessions'].length).to eq(1)

      token_c = login_token(address: email, client: client)
      delete '/api/v1/auth/sessions/others', headers: auth_headers(token_a), as: :json
      expect(response).to have_http_status(:forbidden)
      step_up_with_passkey(token_a, address: email, client: client)
      delete '/api/v1/auth/sessions/others', headers: auth_headers(token_a), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['revoked_count']).to eq(1)
      get '/api/v1/auth/sessions', headers: auth_headers(token_a), as: :json
      expect(json_body['sessions'].length).to eq(1)
      expect(json_body['sessions'].first['current']).to be(true)
      get '/api/v1/auth/sessions', headers: auth_headers(token_c), as: :json
      expect(response).to have_http_status(:unauthorized)
      _ = token_b
    end
  end

  describe 'devices' do
    it 'requires step-up to enrol, stores platform, and gates trust on step-up' do
      email = fresh_email
      client, token = register_passkey(address: email)
      device_key = new_device_key
      enroll_params = lambda do
        post '/api/v1/devices/challenges', headers: auth_headers(token), params: { purpose: 'enroll' }, as: :json
        challenge = json_body['challenge']
        { public_key: device_public_key(device_key), challenge: challenge,
          signature: device_signature(device_key, 'enroll', challenge: challenge, public_key: device_public_key(device_key)),
          name_encrypted: Base64.strict_encode64('macbook'), platform: 'macOS' }
      end
      post '/api/v1/devices/enroll', headers: auth_headers(token), params: enroll_params.call, as: :json
      expect(response).to have_http_status(:forbidden)
      step_up_with_passkey(token, address: email, client: client)
      post '/api/v1/devices/enroll', headers: auth_headers(token), params: enroll_params.call, as: :json
      expect(response).to have_http_status(:created)
      device_id = json_body['device']['id']
      expect(json_body['device']['platform']).to eq('macOS')

      fresh_token = login_token(address: email, client: client)
      patch "/api/v1/devices/#{device_id}", headers: auth_headers(fresh_token),
            params: { trusted: true }, as: :json
      expect(response).to have_http_status(:forbidden)
      step_up_with_passkey(fresh_token, address: email, client: client)
      patch "/api/v1/devices/#{device_id}", headers: auth_headers(fresh_token),
            params: { trusted: true }, as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['device']['trusted_at']).to be_present
      patch "/api/v1/devices/#{device_id}", headers: auth_headers(fresh_token),
            params: { trusted: false }, as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['device']['trusted_at']).to be_nil
    end
  end

  describe 'recovery (H5 fix)' do
    def register_verifier(token, signing_key)
      verify_b64 = Base64.strict_encode64(signing_key.verify_key.to_bytes)
      post '/api/v1/recovery/verifiers', headers: auth_headers(token),
           params: { public_key: verify_b64 }, as: :json
      expect(response).to have_http_status(:created)
      expect(json_body['verifier']['fingerprint']).to eq(Digest::SHA256.hexdigest(signing_key.verify_key.to_bytes)[0, 16])
      expect(json_body['rotated_token']).to start_with('sess_')
      json_body['rotated_token']
    end

    def create_challenge(email)
      post '/api/v1/recovery/challenges', params: { email: email, kind: 'recovery_key' }, as: :json
      expect(response).to have_http_status(:created)
      json_body
    end

    def verify_challenge(challenge_id:, email:, signing_key:, challenge:)
      signature = signing_key.sign(b64url_decode(challenge))
      post '/api/v1/recovery/verify',
           params: { challenge_id: challenge_id, email: email,
                     signature: Base64.strict_encode64(signature) }, as: :json
      json_body
    end

    it 'persists the challenge (digest + ciphertext, never raw) and verifies a real signature' do
      email = fresh_email
      client, token = register_passkey(address: email)
      signing_key = RbNaCl::SigningKey.generate
      step_up_with_passkey(token, address: email, client: client)
      register_verifier(token, signing_key)
      body = create_challenge(email)
      expect(body['challenge_id']).to be_present
      expect(body['challenge']).to be_present
      expect(body['expires_in']).to eq(300)
      record = RecoveryChallenge.last
      expect(record.challenge_digest).to eq(Digest::SHA256.hexdigest(b64url_decode(body['challenge'])))
      expect(record.challenge_encrypted).not_to eq(body['challenge'])
      expect(record.attempts).to eq(0)
      result = verify_challenge(challenge_id: body['challenge_id'], email: email,
                                signing_key: signing_key, challenge: body['challenge'])
      expect(response).to have_http_status(:ok)
      expect(result['token']).to start_with('sess_')
      expect(result['recovery_session']).to be(true)
      expect(result['expires_in']).to eq(900)
      expect(Session.find_by(user: User.find_by(email: email), recovery_session: true)).to be_present
      expect(record.reload.consumed_at).to be_present
    end

    it 'rejects a wrong signature, an expired challenge, and a replayed challenge' do
      email = fresh_email
      client, token = register_passkey(address: email)
      signing_key = RbNaCl::SigningKey.generate
      step_up_with_passkey(token, address: email, client: client)
      register_verifier(token, signing_key)
      sessions_before = Session.count

      body = create_challenge(email)
      other_key = RbNaCl::SigningKey.generate
      verify_challenge(challenge_id: body['challenge_id'], email: email,
                       signing_key: other_key, challenge: body['challenge'])
      expect(response).to have_http_status(:unauthorized)
      expect(Session.count).to eq(sessions_before)

      expired = create_challenge(email)
      RecoveryChallenge.find(expired['challenge_id']).update!(expires_at: 1.minute.ago)
      verify_challenge(challenge_id: expired['challenge_id'], email: email,
                       signing_key: signing_key, challenge: expired['challenge'])
      expect(response).to have_http_status(:unauthorized)

      replay = create_challenge(email)
      verify_challenge(challenge_id: replay['challenge_id'], email: email,
                       signing_key: signing_key, challenge: replay['challenge'])
      expect(response).to have_http_status(:ok)
      verify_challenge(challenge_id: replay['challenge_id'], email: email,
                       signing_key: signing_key, challenge: replay['challenge'])
      expect(response).to have_http_status(:unauthorized)
    end

    it 'consumes a challenge after 5 failed attempts' do
      email = fresh_email
      client, token = register_passkey(address: email)
      signing_key = RbNaCl::SigningKey.generate
      step_up_with_passkey(token, address: email, client: client)
      register_verifier(token, signing_key)
      body = create_challenge(email)
      other_key = RbNaCl::SigningKey.generate
      5.times do
        verify_challenge(challenge_id: body['challenge_id'], email: email,
                         signing_key: other_key, challenge: body['challenge'])
        expect(response).to have_http_status(:unauthorized)
      end
      expect(RecoveryChallenge.last.consumed_at).to be_present
    end

    it 'returns the same shape for unknown emails, without persisting' do
      count_before = RecoveryChallenge.count
      body = create_challenge('ghost@example.test')
      expect(body['challenge_id']).to be_nil
      expect(body['challenge']).to be_present
      expect(body['expires_in']).to eq(300)
      expect(RecoveryChallenge.count).to eq(count_before)
    end

    it 'requires step-up to register a verifier and rejects a bad key' do
      email = fresh_email
      client, token = register_passkey(address: email)
      signing_key = RbNaCl::SigningKey.generate
      post '/api/v1/recovery/verifiers', headers: auth_headers(token),
           params: { public_key: Base64.strict_encode64(signing_key.verify_key.to_bytes) }, as: :json
      expect(response).to have_http_status(:forbidden)
      step_up_with_passkey(token, address: email, client: client)
      post '/api/v1/recovery/verifiers', headers: auth_headers(token),
           params: { public_key: Base64.strict_encode64('short') }, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      new_token = register_verifier(token, signing_key)
      get '/api/v1/recovery/verifiers', headers: auth_headers(new_token), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['verifiers'].length).to eq(1)
      expect(json_body['verifiers'].first).not_to have_key('public_key')
    end
  end

  describe 'GET /v1/auth/activity' do
    it 'returns the newest audit events for the user' do
      email = fresh_email
      client, token = register_passkey(address: email)
      login_token(address: email, client: client)
      get '/api/v1/auth/activity', headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:ok)
      types = json_body['events'].map { |e| e['event_type'] }
      # No device proof is sent here, so no device is enrolled (devices are
      # never created implicitly any more — see device_binding_spec.rb).
      expect(types).to include('account_created', 'passkey_registration_verified', 'passkey_authentication_verified')
      expect(types).not_to include('device_enrolled')
      expect(json_body['events'].length).to be <= 50
      expect(json_body['events'].first).to have_key('metadata')
    end
  end
end
