require 'rails_helper'
require 'webauthn/fake_client'
require 'rotp'

# Device proof-of-possession (specs/device-identity.md) through the real
# routes: real WebAuthn FakeClient ceremonies, real Ed25519 device keys
# (RbNaCl), real TOTP codes. Nothing in the code under test is stubbed.
RSpec.describe 'Device proof-of-possession', type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:origin) { 'http://localhost:3000' }
  let(:email) { "device-#{SecureRandom.hex(4)}@example.test" }
  let(:client) { WebAuthn::FakeClient.new(origin) }

  def json_body = JSON.parse(response.body)
  def auth_headers(token) = { 'Authorization' => "Bearer #{token}" }
  def session_for(token) = Session.find_by!(token_digest: Digest::SHA256.hexdigest(token))

  # Sign-up with an optional device proof built from THIS ceremony's challenge.
  def sign_up(device_key: nil, proof: nil)
    options = registration_options_via_api(email)
    challenge = options['creation_options']['challenge']
    credential = client.create(challenge: challenge, user_verified: true)
    device = proof || (device_key && enroll_proof(device_key, challenge, platform: 'spec'))
    post '/api/v1/auth/passkeys/verify',
         params: { email: email, credential: credential, kind: 'registration', device: device }.compact, as: :json
    json_body
  end

  # Login; `device` is a lambda(challenge) -> proof hash, or nil.
  def sign_in(device: nil)
    post '/api/v1/auth/passkeys/authenticate', params: { email: email }, as: :json
    challenge = json_body['request_options']['challenge']
    allow = User.find_by(email: email).authenticators.active.pluck(:credential_id)
    assertion = client.get(challenge: challenge, user_verified: true, allow_credentials: allow)
    post '/api/v1/auth/passkeys/verify',
         params: { email: email, credential: assertion, kind: 'authentication', device: device&.call(challenge) }.compact,
         as: :json
    json_body
  end

  def signed_up_with_device
    key = new_device_key
    body = sign_up(device_key: key)
    expect(response).to have_http_status(:ok)
    [key, body['device_id'], body['token']]
  end

  def device_challenge(token, purpose)
    post '/api/v1/devices/challenges', headers: auth_headers(token), params: { purpose: purpose }, as: :json
    expect(response).to have_http_status(:created)
    json_body['challenge']
  end

  def step_up(token)
    post '/api/v1/auth/step-up/passkey/options', headers: auth_headers(token), as: :json
    allow = User.find_by(email: email).authenticators.active.pluck(:credential_id)
    assertion = client.get(challenge: json_body['request_options']['challenge'], user_verified: true, allow_credentials: allow)
    post '/api/v1/auth/step-up/passkey', headers: auth_headers(token), params: { credential: assertion }, as: :json
    expect(response).to have_http_status(:ok)
  end

  describe 'sign-up' do
    it 'enrols the device with proof of possession and binds the first session to it' do
      key, device_id, token = signed_up_with_device
      device = Device.find(device_id)
      expect(device.public_key_alg).to eq('ed25519')
      expect(device.public_key.b).to eq(key.verify_key.to_bytes)
      expect(device.platform).to eq('spec')
      expect(session_for(token).device_id).to eq(device_id)
      expect(AuditEvent.where(device: device, event_type: %w[device_enrolled device_bound]).count).to eq(2)
    end

    it 'issues an UNBOUND session when no device proof is sent (the server never picks a device)' do
      body = sign_up
      expect(response).to have_http_status(:ok)
      expect(body['device_id']).to be_nil
      expect(session_for(body['token']).device_id).to be_nil
      expect(Device.count).to eq(0)
    end

    it 'rejects an enrolment signed by a different key, and rolls the new account back' do
      claimed = new_device_key
      signer = new_device_key
      options = registration_options_via_api(email)
      challenge = options['creation_options']['challenge']
      credential = client.create(challenge: challenge, user_verified: true)
      forged = { public_key: device_public_key(claimed),
                 signature: device_signature(signer, 'enroll', challenge: challenge, public_key: device_public_key(claimed)) }
      post '/api/v1/auth/passkeys/verify', params: { email: email, credential: credential, kind: 'registration', device: forged },
                                           as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(json_body).to eq('error' => 'device_verification_failed')
      expect(User.where(email: email)).not_to exist
      expect(Device.count).to eq(0)
      expect(Session.count).to eq(0)
      expect(EmailVerification.find_by!(email: email).ticket_consumed_at).to be_nil
    end

    it 'rejects an enrolment signed over another challenge (replayed proof)' do
      key = new_device_key
      stale = enroll_proof(key, b64url(SecureRandom.bytes(32)))
      sign_up(proof: stale)
      expect(response).to have_http_status(:unauthorized)
      expect(json_body['error']).to eq('device_verification_failed')
      expect(Device.count).to eq(0)
    end
  end

  describe 'sign-in' do
    it 'binds the session to an existing device only with a fresh signature by that device' do
      key, device_id, _token = signed_up_with_device
      body = sign_in(device: ->(challenge) { bind_proof(key, challenge, device_id) })
      expect(response).to have_http_status(:ok)
      expect(body['device_id']).to eq(device_id)
      expect(session_for(body['token']).device_id).to eq(device_id)
    end

    it 'leaves the session unbound without a proof, even when the account has devices' do
      signed_up_with_device
      body = sign_in
      expect(response).to have_http_status(:ok)
      expect(body['device_id']).to be_nil
      expect(session_for(body['token']).device_id).to be_nil
    end

    it 'rejects a signature from another device key for this device id' do
      _key, device_id, _token = signed_up_with_device
      intruder = new_device_key
      sessions_before = Session.count
      sign_in(device: ->(challenge) { bind_proof(intruder, challenge, device_id) })
      expect(response).to have_http_status(:unauthorized)
      expect(json_body['error']).to eq('device_verification_failed')
      expect(Session.count).to eq(sessions_before)
      expect(AuditEvent.where(event_type: 'device_bind_failed').pluck(:metadata)).to include({ 'purpose' => 'session-bind' })
    end

    it 'rejects a proof replayed from an earlier sign-in (old challenge)' do
      key, device_id, _token = signed_up_with_device
      captured = nil
      sign_in(device: ->(challenge) { captured = bind_proof(key, challenge, device_id) })
      expect(response).to have_http_status(:ok)
      sign_in(device: ->(_challenge) { captured })
      expect(response).to have_http_status(:unauthorized)
      expect(json_body['error']).to eq('device_verification_failed')
    end

    it "rejects a revoked device and another account's device" do
      key, device_id, token = signed_up_with_device
      delete "/api/v1/devices/#{device_id}", headers: auth_headers(token)
      expect(response).to have_http_status(:no_content)
      sign_in(device: ->(challenge) { bind_proof(key, challenge, device_id) })
      expect(response).to have_http_status(:unauthorized)

      other_user = User.create!(email: "other-#{SecureRandom.hex(4)}@example.test")
      other_key = new_device_key
      other_device = Devices::Enroll.call(user: other_user, public_key: other_key.verify_key.to_bytes, public_key_alg: 'ed25519')
      sign_in(device: ->(challenge) { bind_proof(other_key, challenge, other_device.id) })
      expect(response).to have_http_status(:unauthorized)
    end

    it 'never accepts a legacy device row (passkey COSE key, no ed25519 alg)' do
      signed_up_with_device
      user = User.find_by!(email: email)
      key = new_device_key
      legacy = user.devices.create!(public_key: key.verify_key.to_bytes) # public_key_alg NULL
      sign_in(device: ->(challenge) { bind_proof(key, challenge, legacy.id) })
      expect(response).to have_http_status(:unauthorized)
    end

    it 'with MFA, binds or enrols only after the second factor succeeds' do
      key, device_id, token = signed_up_with_device
      post '/api/v1/auth/mfa/enroll', headers: auth_headers(token), as: :json
      totp = ROTP::TOTP.new(json_body['secret'])
      post '/api/v1/auth/mfa/confirm', headers: auth_headers(token), params: { code: totp.now }, as: :json
      expect(response).to have_http_status(:ok)
      recovery_code = json_body['recovery_codes'].first

      body = sign_in(device: ->(challenge) { bind_proof(key, challenge, device_id) })
      expect(body['mfa_required']).to be(true)
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: totp.at(Time.now + 30) }, as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['device_id']).to eq(device_id)

      second = new_device_key
      body = sign_in(device: ->(challenge) { enroll_proof(second, challenge) })
      expect(body['mfa_required']).to be(true)
      expect(Device.where(public_key_alg: 'ed25519').count).to eq(1) # nothing created before the 2nd factor
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: '000000' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(Device.where(public_key_alg: 'ed25519').count).to eq(1) # wrong 2nd factor: still nothing

      body = sign_in(device: ->(challenge) { enroll_proof(second, challenge) })
      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: recovery_code }, as: :json
      expect(response).to have_http_status(:ok)
      new_device = Device.find(json_body['device_id'])
      expect(new_device.public_key.b).to eq(second.verify_key.to_bytes)
    end
  end

  describe 'explicit challenge + bind (authenticated session)' do
    it 'binds an unbound session with a fresh challenge; the challenge cannot be replayed' do
      key, device_id, _token = signed_up_with_device
      token = sign_in['token'] # unbound session
      challenge = device_challenge(token, 'session-bind')
      expect(challenge).to match(/\A[A-Za-z0-9_-]{43}\z/)
      expect(DeviceChallenge.last.challenge_digest).to eq(Digest::SHA256.hexdigest(challenge))
      signature = device_signature(key, 'session-bind', challenge: challenge, device_id: device_id)

      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token), params: { challenge: challenge, signature: signature }, as: :json
      expect(response).to have_http_status(:ok)
      expect(session_for(token).device_id).to eq(device_id)

      other = sign_in['token']
      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(other), params: { challenge: challenge, signature: signature }, as: :json
      expect(response).to have_http_status(:unauthorized) # replay, and another session's challenge
      expect(session_for(other).device_id).to be_nil
    end

    it 'refuses a wrong key, an expired challenge, a challenge for another purpose, and re-binding' do
      key, device_id, _token = signed_up_with_device
      token = sign_in['token']

      challenge = device_challenge(token, 'session-bind')
      wrong = device_signature(new_device_key, 'session-bind', challenge: challenge, device_id: device_id)
      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token), params: { challenge: challenge, signature: wrong }, as: :json
      expect(response).to have_http_status(:unauthorized)
      # The failed attempt burned the challenge: the right signature over it now fails too.
      right = device_signature(key, 'session-bind', challenge: challenge, device_id: device_id)
      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token), params: { challenge: challenge, signature: right }, as: :json
      expect(response).to have_http_status(:unauthorized)

      challenge = device_challenge(token, 'session-bind')
      travel 2.minutes + 1.second do
        post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token),
             params: { challenge: challenge, signature: device_signature(key, 'session-bind', challenge: challenge, device_id: device_id) }, as: :json
        expect(response).to have_http_status(:unauthorized)
      end

      challenge = device_challenge(token, 'enroll')
      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token),
           params: { challenge: challenge, signature: device_signature(key, 'session-bind', challenge: challenge, device_id: device_id) }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(session_for(token).device_id).to be_nil

      challenge = device_challenge(token, 'session-bind')
      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token),
           params: { challenge: challenge, signature: device_signature(key, 'session-bind', challenge: challenge, device_id: device_id) }, as: :json
      expect(response).to have_http_status(:ok)
      challenge = device_challenge(token, 'session-bind')
      post "/api/v1/devices/#{device_id}/bind", headers: auth_headers(token),
           params: { challenge: challenge, signature: device_signature(key, 'session-bind', challenge: challenge, device_id: device_id) }, as: :json
      expect(response).to have_http_status(:conflict)
    end

    it 'rejects an unknown purpose and unauthenticated callers' do
      _key, _device_id, token = signed_up_with_device
      post '/api/v1/devices/challenges', headers: auth_headers(token), params: { purpose: 'sync-event' }, as: :json
      expect(response).to have_http_status(:unprocessable_entity)
      post '/api/v1/devices/challenges', params: { purpose: 'enroll' }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe 'POST /api/v1/devices/enroll' do
    it 'requires step-up AND proof of possession; binds an unbound session' do
      signed_up_with_device
      token = sign_in['token']
      key = new_device_key
      challenge = device_challenge(token, 'enroll')
      params = { public_key: device_public_key(key), challenge: challenge, platform: 'macOS',
                 signature: device_signature(key, 'enroll', challenge: challenge, public_key: device_public_key(key)) }
      post '/api/v1/devices/enroll', headers: auth_headers(token), params: params, as: :json
      expect(response).to have_http_status(:forbidden)

      step_up(token)
      challenge = device_challenge(token, 'enroll')
      unsigned = params.merge(challenge: challenge, signature: nil)
      post '/api/v1/devices/enroll', headers: auth_headers(token), params: unsigned, as: :json
      expect(response).to have_http_status(:unauthorized)

      challenge = device_challenge(token, 'enroll')
      forged = params.merge(challenge: challenge,
                            signature: device_signature(new_device_key, 'enroll', challenge: challenge, public_key: device_public_key(key)))
      post '/api/v1/devices/enroll', headers: auth_headers(token), params: forged, as: :json
      expect(response).to have_http_status(:unauthorized)

      challenge = device_challenge(token, 'enroll')
      signed = params.merge(challenge: challenge,
                            signature: device_signature(key, 'enroll', challenge: challenge, public_key: device_public_key(key)))
      post '/api/v1/devices/enroll', headers: auth_headers(token), params: signed, as: :json
      expect(response).to have_http_status(:created)
      expect(json_body['session_bound']).to be(true)
      expect(json_body['device']['platform']).to eq('macOS')
      expect(session_for(token).device_id).to eq(json_body['device']['id'])
      expect(Device.find(json_body['device']['id']).public_key.b).to eq(key.verify_key.to_bytes)
    end
  end

  it 'issues recovery sessions unbound' do
    signed_up_with_device
    user = User.find_by!(email: email)
    recovery_key = RbNaCl::SigningKey.generate
    user.recovery_verifiers.create!(public_key: Base64.strict_encode64(recovery_key.verify_key.to_bytes))
    post '/api/v1/recovery/challenges', params: { email: email, kind: 'recovery_key' }, as: :json
    challenge_id = json_body['challenge_id']
    challenge_bytes = Authentication::SecretEncryptor.decode_base64_loose(json_body['challenge'])
    post '/api/v1/recovery/verify', params: { challenge_id: challenge_id, email: email,
                                              signature: Base64.strict_encode64(recovery_key.sign(challenge_bytes)) }, as: :json
    expect(response).to have_http_status(:ok)
    expect(json_body['device_id']).to be_nil
    expect(session_for(json_body['token']).device_id).to be_nil
  end
end
