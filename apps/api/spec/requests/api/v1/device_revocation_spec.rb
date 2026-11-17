require 'rails_helper'
require 'webauthn/fake_client'
require 'rotp'

# Durable device revocation (specs/device-identity.md §6.3, QA DEFECT-H2)
# through the real routes: real WebAuthn FakeClient passkeys (one client =
# one passkey; using it from two device keys models a synced passkey) and
# real Ed25519 device keys. Nothing in the code under test is stubbed.
RSpec.describe 'Durable device revocation', type: :request do
  let(:origin) { 'http://localhost:3000' }
  let(:email) { "revoke-#{SecureRandom.hex(4)}@example.test" }
  let(:passkey_a) { WebAuthn::FakeClient.new(origin) }

  def json_body = JSON.parse(response.body)
  def auth(token) = { 'Authorization' => "Bearer #{token}" }
  def session_for(token) = Session.find_by!(token_digest: Digest::SHA256.hexdigest(token))
  def user = User.find_by!(email: email)

  # Sign-up with passkey A on device key `key`. Returns [device_id, token].
  def sign_up(key)
    options = registration_options_via_api(email)
    challenge = options['creation_options']['challenge']
    post '/api/v1/auth/passkeys/verify', params: { email: email, kind: 'registration', device: enroll_proof(key, challenge),
                                                   credential: passkey_a.create(challenge: challenge, user_verified: true) }, as: :json
    expect(response).to have_http_status(:ok)
    [json_body['device_id'], json_body['token']]
  end

  # Sign-in with `client`; `device` is a lambda(challenge) -> proof, or nil.
  def sign_in(client, device: nil)
    post '/api/v1/auth/passkeys/authenticate', params: { email: email }, as: :json
    challenge = json_body['request_options']['challenge']
    # Every credential id (revoked too), so a revoked passkey can still try.
    assertion = client.get(challenge: challenge, user_verified: true, allow_credentials: user.authenticators.pluck(:credential_id))
    post '/api/v1/auth/passkeys/verify',
         params: { email: email, kind: 'authentication', credential: assertion, device: device&.call(challenge) }.compact, as: :json
    response.status
  end

  def step_up(token, client)
    post '/api/v1/auth/step-up/passkey/options', headers: auth(token), as: :json
    assertion = client.get(challenge: json_body['request_options']['challenge'], user_verified: true,
                           allow_credentials: user.authenticators.active.pluck(:credential_id))
    post '/api/v1/auth/step-up/passkey', headers: auth(token), params: { credential: assertion }, as: :json
    expect(response).to have_http_status(:ok)
  end

  # Device A signs up; device B signs in with the SAME (synced) passkey and
  # enrols its own device key. Returns the ids/tokens and keys.
  def two_devices
    key_a = new_device_key
    key_b = new_device_key
    device_a, token_a = sign_up(key_a)
    expect(sign_in(passkey_a, device: ->(c) { enroll_proof(key_b, c) })).to eq(200)
    { key_a: key_a, key_b: key_b, device_a: device_a, token_a: token_a, device_b: json_body['device_id'], token_b: json_body['token'] }
  end

  it 'records the enrolling passkey on each device and session, and lists synced use' do
    d = two_devices
    passkey = user.authenticators.sole
    expect(Device.find(d[:device_a]).authenticator).to eq(passkey)
    expect(Device.find(d[:device_b]).authenticator).to eq(passkey)
    expect(session_for(d[:token_b]).authenticator).to eq(passkey)

    get '/api/v1/devices', headers: auth(d[:token_a]), as: :json
    rows = json_body['devices'].index_by { |r| r['id'] }
    expect(rows[d[:device_a]]).to include('authenticator_id' => passkey.id, 'passkey_active_devices' => 2, 'current' => true)
    expect(rows[d[:device_b]]).to include('current' => false)
  end

  describe 'revoking a device (passkey kept)' do
    it 'stops the revoked browser from signing back in and enrolling a new device key (DEFECT-H2)' do
      d = two_devices
      delete "/api/v1/devices/#{d[:device_b]}", headers: auth(d[:token_a])
      expect(response).to have_http_status(:no_content)
      expect(user.authenticators.sole.reapproval_required_at).to be_present

      # B tries its revoked device key, then (like the client does) a fresh one, then no device at all.
      expect(sign_in(passkey_a, device: ->(c) { bind_proof(d[:key_b], c, d[:device_b]) })).to eq(401)
      expect(json_body).to eq('error' => 'device_verification_failed')
      sessions_before = Session.count
      expect(sign_in(passkey_a, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(403)
      expect(json_body).to eq('error' => 'device_approval_required')
      expect(sign_in(passkey_a)).to eq(403)
      expect(Session.count).to eq(sessions_before)
      expect(Device.active.where(user: user).pluck(:id)).to eq([d[:device_a]])
    end

    it 'still lets the same (synced) passkey sign in on a device that is still active' do
      d = two_devices
      delete "/api/v1/devices/#{d[:device_b]}", headers: auth(d[:token_a])
      expect(sign_in(passkey_a, device: ->(c) { bind_proof(d[:key_a], c, d[:device_a]) })).to eq(200)
      expect(json_body['device_id']).to eq(d[:device_a])
    end

    it 'never lets a revoked device key enrol again, even after re-approval' do
      d = two_devices
      delete "/api/v1/devices/#{d[:device_b]}", headers: auth(d[:token_a])
      step_up(d[:token_a], passkey_a)
      post "/api/v1/auth/passkeys/#{user.authenticators.sole.id}/approve", headers: auth(d[:token_a]), as: :json
      expect(response).to have_http_status(:ok)

      expect(sign_in(passkey_a, device: ->(c) { enroll_proof(d[:key_b], c) })).to eq(401)
      expect(json_body['error']).to eq('device_verification_failed')
      expect(sign_in(passkey_a, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(200) # a NEW key, after approval
    end

    it 'refuses enrolment from a session of the restricted passkey, and with MFA refuses before the second factor' do
      d = two_devices
      delete "/api/v1/devices/#{d[:device_b]}", headers: auth(d[:token_a])
      expect(sign_in(passkey_a, device: ->(c) { bind_proof(d[:key_a], c, d[:device_a]) })).to eq(200)
      token = json_body['token']
      step_up(token, passkey_a)
      post '/api/v1/devices/challenges', headers: auth(token), params: { purpose: 'enroll' }, as: :json
      challenge = json_body['challenge']
      key = new_device_key
      post '/api/v1/devices/enroll', headers: auth(token), as: :json,
                                     params: { public_key: device_public_key(key), challenge: challenge,
                                               signature: device_signature(key, 'enroll', challenge: challenge, public_key: device_public_key(key)) }
      expect(response).to have_http_status(:forbidden)
      expect(json_body).to eq('error' => 'device_approval_required')

      post '/api/v1/auth/mfa/enroll', headers: auth(token), as: :json
      totp = ROTP::TOTP.new(json_body['secret'])
      post '/api/v1/auth/mfa/confirm', headers: auth(token), params: { code: totp.now }, as: :json
      expect(sign_in(passkey_a, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(403)
      expect(json_body).to eq('error' => 'device_approval_required') # no mfa_token handed out
    end
  end

  describe 're-approval (POST /api/v1/auth/passkeys/:id/approve)' do
    it 'needs step-up from a still-trusted device; then the passkey can enrol again' do
      d = two_devices
      delete "/api/v1/devices/#{d[:device_b]}", headers: auth(d[:token_a])
      passkey_id = user.authenticators.sole.id

      post "/api/v1/auth/passkeys/#{passkey_id}/approve", headers: auth(d[:token_a]), as: :json
      expect(response).to have_http_status(:forbidden)
      expect(json_body).to eq('error' => 'step_up_required')

      # An unbound (non-recovery) session is not a trusted device, even stepped up.
      unbound = Authentication::SessionTokens.issue(user: user, step_up_verified_at: Time.current, step_up_method: 'passkey')
      post "/api/v1/auth/passkeys/#{passkey_id}/approve", headers: auth(unbound), as: :json
      expect(response).to have_http_status(:forbidden)
      expect(json_body).to eq('error' => 'trusted_device_required')

      step_up(d[:token_a], passkey_a)
      post "/api/v1/auth/passkeys/#{passkey_id}/approve", headers: auth(d[:token_a]), as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body['passkey']['reapproval_required_at']).to be_nil
      expect(AuditEvent.where(event_type: 'passkey_reapproved')).to exist
      expect(sign_in(passkey_a, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(200)
    end

    it 'accepts a recovery session when no trusted device is left' do
      key = new_device_key
      device_id, token = sign_up(key)
      delete "/api/v1/devices/#{device_id}", headers: auth(token) # the only device
      recovery = Authentication::SessionTokens.issue(user: user, recovery_session: true,
                                                    step_up_verified_at: Time.current, step_up_method: 'recovery_key')
      post "/api/v1/auth/passkeys/#{user.authenticators.sole.id}/approve", headers: auth(recovery), as: :json
      expect(response).to have_http_status(:ok)
      expect(sign_in(passkey_a, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(200)
    end
  end

  describe 'revoking the device AND its passkey (?revoke_passkey=true)' do
    it 'requires step-up, revokes the passkey so it cannot sign in at all, and rotates the token' do
      d = two_devices
      passkey_b = WebAuthn::FakeClient.new(origin)
      step_up(d[:token_a], passkey_a)
      post '/api/v1/auth/passkeys/add/options', headers: auth(d[:token_a]), as: :json
      post '/api/v1/auth/passkeys/add/verify', headers: auth(d[:token_a]), as: :json,
                                               params: { credential: passkey_b.create(challenge: json_body['creation_options']['challenge'], user_verified: true) }
      expect(response).to have_http_status(:created)
      expect(sign_in(passkey_b, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(200)
      device_c = Device.find(json_body['device_id'])

      expect(sign_in(passkey_a, device: ->(c) { bind_proof(d[:key_a], c, d[:device_a]) })).to eq(200)
      fresh = json_body['token']
      delete "/api/v1/devices/#{device_c.id}?revoke_passkey=true", headers: auth(fresh)
      expect(response).to have_http_status(:forbidden)
      step_up(fresh, passkey_a)
      delete "/api/v1/devices/#{device_c.id}?revoke_passkey=true", headers: auth(fresh)
      expect(response).to have_http_status(:ok)
      expect(json_body).to include('revoked' => true, 'passkey' => 'revoked')
      expect(json_body['rotated_token']).to start_with('sess_')

      expect(device_c.authenticator.reload.revoked_at).to be_present
      expect(sign_in(passkey_b, device: ->(c) { enroll_proof(new_device_key, c) })).to eq(401)
      expect(user.authenticators.find_by!(credential_id: device_c.authenticator.credential_id)).to be_revoked
    end

    it 'refuses to revoke the last passkey while MFA is off' do
      d = two_devices
      step_up(d[:token_a], passkey_a)
      delete "/api/v1/devices/#{d[:device_b]}?revoke_passkey=true", headers: auth(d[:token_a])
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json_body['error']).to eq('last_authenticator')
      expect(Device.find(d[:device_b]).revoked_at).to be_nil
    end
  end

  it 'marks every passkey for re-approval when the enrolling passkey is unknown (pre-existing devices)' do
    d = two_devices
    Device.find(d[:device_b]).update!(authenticator: nil) # as enrolled before this rule
    delete "/api/v1/devices/#{d[:device_b]}", headers: auth(d[:token_a])
    expect(user.authenticators.active.pluck(:reapproval_required_at)).to all(be_present)
    expect(AuditEvent.where(event_type: 'device_revoked').last.metadata).to eq('passkey' => 'reapproval_required_all')
  end
end
