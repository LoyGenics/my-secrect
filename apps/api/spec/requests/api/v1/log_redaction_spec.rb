require 'rails_helper'
require 'webauthn/fake_client'
require 'rotp'
require 'rbnacl'

# Security event logging, end to end through the real routes:
#   1. every security action leaves an audit event, and
#   2. no secret produced or sent along the way — email code, registration
#      ticket, session / MFA tokens, TOTP secret and codes, recovery codes,
#      device challenges and signatures, recovery challenge and signature,
#      private keys — appears in the Rails log output (captured at DEBUG,
#      so SQL binds and request parameters are included) or in audit
#      metadata.
RSpec.describe 'Security event logging', type: :request do
  let(:origin) { 'http://localhost:3000' }
  let(:email) { "audit-#{SecureRandom.hex(4)}@example.test" }
  let(:client) { WebAuthn::FakeClient.new(origin) }

  around do |example|
    @log_io = StringIO.new
    capture = ActiveSupport::Logger.new(@log_io)
    capture.level = :debug
    Rails.logger.broadcast_to(capture)
    example.run
  ensure
    Rails.logger.stop_broadcasting_to(capture)
  end

  def json_body = JSON.parse(response.body)
  def auth(token) = { 'Authorization' => "Bearer #{token}" }
  def session_for(token) = Session.find_by!(token_digest: Digest::SHA256.hexdigest(token))

  def passkey_assertion(path_prefix, token: nil)
    post "#{path_prefix}", params: (token ? {} : { email: email }), headers: (token ? auth(token) : {}), as: :json
    challenge = json_body['request_options']['challenge']
    allow = User.find_by!(email: email).authenticators.active.pluck(:credential_id)
    [challenge, client.get(challenge: challenge, user_verified: true, allow_credentials: allow)]
  end

  # Runs sign-up, sign-in (with and without MFA), step-up, device binding,
  # recovery, session/device revocation, MFA disable and account deletion.
  # Returns every secret value that crossed the wire.
  def run_security_flows
    secrets = []
    device_key = new_device_key
    secrets += [b64url(device_key.to_bytes), device_key.to_bytes.unpack1('H*')]

    # Sign-up: a wrong code, then the right one.
    post '/api/v1/auth/email/request', params: { email: email }, as: :json
    code = delivered_code_for(email)
    wrong = format('%06d', (code.to_i + 1) % 1_000_000)
    secrets += [code, wrong]
    post '/api/v1/auth/email/verify', params: { email: email, code: wrong }, as: :json
    post '/api/v1/auth/email/verify', params: { email: email, code: code }, as: :json
    ticket = json_body.fetch('registration_ticket')
    secrets << ticket
    post '/api/v1/auth/passkeys/register', params: { email: email, registration_ticket: ticket }, as: :json
    challenge = json_body['creation_options']['challenge']
    proof = enroll_proof(device_key, challenge)
    secrets << proof[:signature]
    post '/api/v1/auth/passkeys/verify', params: { email: email, kind: 'registration', device: proof,
                                                   credential: client.create(challenge: challenge, user_verified: true) }, as: :json
    expect(response).to have_http_status(:ok)
    token = json_body['token']
    device_id = json_body['device_id']
    secrets << token

    # A failed sign-in.
    post '/api/v1/auth/passkeys/verify', params: { email: email, kind: 'authentication', credential: { id: 'bogus' } }, as: :json
    expect(response).to have_http_status(:unauthorized)

    # MFA on.
    post '/api/v1/auth/mfa/enroll', headers: auth(token), as: :json
    secret = json_body['secret']
    totp = ROTP::TOTP.new(secret)
    confirm_code = totp.now
    post '/api/v1/auth/mfa/confirm', headers: auth(token), params: { code: confirm_code }, as: :json
    recovery_codes = json_body['recovery_codes']
    token = json_body['rotated_token']
    secrets += [secret, confirm_code, token, *recovery_codes]

    # MFA sign-in with a device bind proof.
    challenge, assertion = passkey_assertion('/api/v1/auth/passkeys/authenticate')
    bind = bind_proof(device_key, challenge, device_id)
    post '/api/v1/auth/passkeys/verify', params: { email: email, kind: 'authentication', credential: assertion, device: bind }, as: :json
    mfa_token = json_body['mfa_token']
    login_code = totp.at(Time.now + 30)
    post '/api/v1/auth/mfa/verify', params: { mfa_token: mfa_token, code: login_code }, as: :json
    expect(response).to have_http_status(:ok)
    bound_token = json_body['token']
    secrets += [bind[:signature], mfa_token, login_code, bound_token]

    # A failed MFA sign-in, then one with a recovery code (unbound session).
    _c, assertion = passkey_assertion('/api/v1/auth/passkeys/authenticate')
    post '/api/v1/auth/passkeys/verify', params: { email: email, kind: 'authentication', credential: assertion }, as: :json
    failed_mfa_token = json_body['mfa_token']
    post '/api/v1/auth/mfa/verify', params: { mfa_token: failed_mfa_token, code: '999999' }, as: :json
    expect(response).to have_http_status(:unauthorized)
    _c, assertion = passkey_assertion('/api/v1/auth/passkeys/authenticate')
    post '/api/v1/auth/passkeys/verify', params: { email: email, kind: 'authentication', credential: assertion }, as: :json
    recovery_mfa_token = json_body['mfa_token']
    post '/api/v1/auth/mfa/verify', params: { mfa_token: recovery_mfa_token, code: recovery_codes.first }, as: :json
    unbound_token = json_body['token']
    secrets += [failed_mfa_token, recovery_mfa_token, unbound_token]

    # Explicit bind with a wrong key (fails).
    post '/api/v1/devices/challenges', headers: auth(unbound_token), params: { purpose: 'session-bind' }, as: :json
    device_challenge = json_body['challenge']
    bad_signature = device_signature(new_device_key, 'session-bind', challenge: device_challenge, device_id: device_id)
    post "/api/v1/devices/#{device_id}/bind", headers: auth(unbound_token),
                                               params: { challenge: device_challenge, signature: bad_signature }, as: :json
    expect(response).to have_http_status(:unauthorized)
    secrets += [device_challenge, bad_signature]

    # Step-up: a wrong TOTP code, then a passkey.
    step_up_wrong = format('%06d', (totp.now.to_i + 3) % 1_000_000)
    post '/api/v1/auth/step-up/totp', headers: auth(bound_token), params: { code: step_up_wrong }, as: :json
    expect(response).to have_http_status(:unauthorized)
    _c, assertion = passkey_assertion('/api/v1/auth/step-up/passkey/options', token: bound_token)
    post '/api/v1/auth/step-up/passkey', headers: auth(bound_token), params: { credential: assertion }, as: :json
    expect(response).to have_http_status(:ok)
    secrets << step_up_wrong

    # Recovery key: register a verifier, then sign in with it.
    recovery_key = RbNaCl::SigningKey.generate
    post '/api/v1/recovery/verifiers', headers: auth(bound_token),
                                       params: { public_key: Base64.strict_encode64(recovery_key.verify_key.to_bytes), derivation: 'v1-hkdf-sha256' }, as: :json
    secrets << json_body['rotated_token']
    post '/api/v1/recovery/challenges', params: { email: email, kind: 'recovery_key' }, as: :json
    recovery_challenge = json_body['challenge']
    recovery_signature = Base64.strict_encode64(recovery_key.sign(Authentication::SecretEncryptor.decode_base64_loose(recovery_challenge)))
    post '/api/v1/recovery/verify', params: { challenge_id: json_body['challenge_id'], email: email, signature: recovery_signature }, as: :json
    recovery_token = json_body['token']
    secrets += [b64url(recovery_key.to_bytes), recovery_challenge, recovery_signature, recovery_token]

    # Revoke a session and the device, disable MFA, delete the account.
    delete "/api/v1/auth/sessions/#{session_for(unbound_token).id}", headers: auth(recovery_token)
    expect(response).to have_http_status(:no_content)
    delete "/api/v1/devices/#{device_id}", headers: auth(recovery_token)
    expect(response).to have_http_status(:no_content)
    post '/api/v1/auth/mfa/disable', headers: auth(recovery_token), as: :json
    final_token = json_body['rotated_token']
    secrets << final_token
    delete '/api/v1/auth/account', headers: auth(final_token)
    expect(response).to have_http_status(:no_content)

    secrets.compact
  end

  # Six-digit codes could collide with digits inside timestamps or hex ids,
  # so they only count when they stand alone.
  def leaked?(text, secret)
    return text.match?(/(?<![0-9a-f.:\-])#{Regexp.escape(secret)}(?![0-9a-f])/) if secret.match?(/\A\d{6}\z/)
    text.include?(secret)
  end

  it 'never writes a secret, code, token or key to the log or to audit metadata' do
    secrets = run_security_flows
    log = @log_io.string
    # The capture really saw the traffic, at DEBUG, with filtering applied.
    expect(log).to include('POST "/api/v1/auth/email/verify"')
    expect(log).to include('"code" => "[FILTERED]"').or include('"code"=>"[FILTERED]"')
    expect(log).to match(/INSERT INTO "email_verifications"/)

    leaks = secrets.select { |secret| leaked?(log, secret) }
    expect(leaks).to be_empty, "secrets found in the log: #{leaks.size}"

    metadata = AuditEvent.pluck(:metadata)
    metadata_json = metadata.to_json
    expect(secrets.select { |secret| leaked?(metadata_json, secret) }).to be_empty
    expect(metadata.flat_map(&:keys).uniq - %w[method via purpose email_verification_id revoked_count]).to be_empty
    expect(metadata_json).not_to include(email)
  end

  it 'records an audit event for every security action' do
    run_security_flows
    types = AuditEvent.pluck(:event_type)
    expect(types).to include(
      'email_verification_requested', 'email_verification_failed', 'email_verification_succeeded', 'account_created',
      'sign_in_succeeded', 'sign_in_failed',
      'device_enrolled', 'device_bound', 'device_bind_failed', 'device_revoked',
      'session_revoked',
      'step_up_verified', 'step_up_failed',
      'mfa_enrollment_started', 'mfa_enabled', 'mfa_verified', 'mfa_recovery_code_used', 'mfa_disabled',
      'recovery_verified', 'account_deleted'
    )
    methods = AuditEvent.where(event_type: 'sign_in_succeeded').pluck(:metadata).map { |m| m['method'] }
    expect(methods).to include('passkey_registration', 'passkey+totp', 'passkey+recovery_code', 'recovery_key')
    failures = AuditEvent.where(event_type: 'sign_in_failed').pluck(:metadata).map { |m| m['method'] }
    expect(failures).to include('passkey', 'mfa')
  end
end
