require 'rails_helper'
require 'webauthn/fake_client'
require 'rotp'

# Sign-in with the email alone (no passkey yet), through the real routes:
# the 6-digit code is read from the delivered mail, device keys are real
# Ed25519 (RbNaCl), passkeys are real FakeClient ceremonies.
RSpec.describe 'Email sign-in without a passkey', type: :request do
  let(:origin) { 'http://localhost:3000' }
  let(:email) { "mail-#{SecureRandom.hex(4)}@example.test" }

  def json_body = JSON.parse(response.body)
  def auth_headers(token) = { 'Authorization' => "Bearer #{token}" }

  def email_session(ticket, device: nil, address: email)
    post '/api/v1/auth/email/session',
         params: { email: address, registration_ticket: ticket, device: device }.compact, as: :json
  end

  def sign_in_with_email(key: new_device_key)
    ticket = registration_ticket_via_api(email)
    email_session(ticket, device: enroll_proof(key, ticket, platform: 'spec'))
    expect(response).to have_http_status(:ok)
    json_body
  end

  def email_step_up(token)
    ActionMailer::Base.deliveries.clear
    post '/api/v1/auth/step-up/email/request', headers: auth_headers(token), as: :json
    expect(response).to have_http_status(:accepted)
    post '/api/v1/auth/step-up/email', headers: auth_headers(token), params: { code: delivered_code_for(email) }, as: :json
  end

  def add_passkey(token, client: WebAuthn::FakeClient.new(origin))
    post '/api/v1/auth/passkeys/add/options', headers: auth_headers(token), as: :json
    credential = client.create(challenge: json_body['creation_options']['challenge'], user_verified: true)
    post '/api/v1/auth/passkeys/add/verify', headers: auth_headers(token), params: { credential: credential }, as: :json
  end

  describe 'POST /api/v1/auth/email/session' do
    it 'creates the account and a device-bound session from the emailed code alone' do
      key = new_device_key
      body = sign_in_with_email(key: key)

      user = User.find_by!(email: email)
      expect(body).to include('user_id' => user.id, 'expires_in' => Authentication::SessionTokens::TTL_SECONDS, 'account_created' => true)
      expect(user.authenticators).to be_empty
      device = Device.find(body['device_id'])
      expect(device.user_id).to eq(user.id)
      expect(device.public_key.b).to eq(key.verify_key.to_bytes)
      expect(Session.find_by!(token_digest: Digest::SHA256.hexdigest(body['token'])).device_id).to eq(device.id)
      expect(user.audit_events.pluck(:event_type)).to include('account_created', 'sign_in_succeeded')
    end

    it 'signs in to an existing email-only account with a second device' do
      sign_in_with_email
      second = new_device_key
      ticket = registration_ticket_via_api(email)
      email_session(ticket, device: enroll_proof(second, ticket))
      expect(response).to have_http_status(:ok)
      expect(json_body['account_created']).to be(false)
      expect(User.where(email: email).count).to eq(1)
      expect(User.find_by!(email: email).devices.count).to eq(2)
    end

    it 'issues an unbound session without a device proof' do
      email_session(registration_ticket_via_api(email))
      expect(response).to have_http_status(:ok)
      expect(json_body['device_id']).to be_nil
    end

    it 'spends the ticket: a second use is refused' do
      ticket = registration_ticket_via_api(email)
      email_session(ticket)
      expect(response).to have_http_status(:ok)
      email_session(ticket)
      expect(response).to have_http_status(:unauthorized)
      expect(json_body).to eq('error' => 'verification_failed')
    end

    it 'refuses a bad device proof, creates nothing and keeps the ticket usable' do
      ticket = registration_ticket_via_api(email)
      key = new_device_key
      stale = enroll_proof(key, 'rt_not-this-ticket')
      email_session(ticket, device: stale)
      expect(response).to have_http_status(:unauthorized)
      expect(json_body).to eq('error' => 'device_verification_failed')
      expect(User.where(email: email)).not_to exist

      email_session(ticket, device: enroll_proof(key, ticket))
      expect(response).to have_http_status(:ok)
    end

    it 'refuses a ticket presented for another address' do
      ticket = registration_ticket_via_api(email)
      email_session(ticket, address: "other-#{email}")
      expect(response).to have_http_status(:unauthorized)
    end

    it 'is closed for an account with a passkey, and never mails it a code' do
      token = sign_in_with_email['token']
      expect(email_step_up(token)).to eq(200)
      add_passkey(token)
      expect(response).to have_http_status(:created)
      ActionMailer::Base.deliveries.clear

      post '/api/v1/auth/email/request', params: { email: email }, as: :json
      expect(response).to have_http_status(:accepted)
      expect(delivered_code_for(email)).to be_nil

      post '/api/v1/auth/email/verify', params: { email: email, code: '123456' }, as: :json
      expect(response).to have_http_status(:unauthorized)
    end

    it 'refuses a ticket minted before the account got its passkey' do
      ticket = registration_ticket_via_api(email)
      token = sign_in_with_email['token']
      email_step_up(token)
      add_passkey(token)
      expect(response).to have_http_status(:created)

      email_session(ticket)
      expect(response).to have_http_status(:unauthorized)
    end

    it 'with MFA, holds the device until the second factor succeeds' do
      token = sign_in_with_email['token']
      email_step_up(token)
      post '/api/v1/auth/mfa/enroll', headers: auth_headers(token), as: :json
      totp = ROTP::TOTP.new(json_body['secret'])
      post '/api/v1/auth/mfa/confirm', headers: auth_headers(token), params: { code: totp.now }, as: :json
      expect(response).to have_http_status(:ok)

      second = new_device_key
      ticket = registration_ticket_via_api(email)
      email_session(ticket, device: enroll_proof(second, ticket))
      expect(response).to have_http_status(:ok)
      expect(json_body).to include('mfa_required' => true)
      expect(json_body).not_to have_key('token')
      expect(User.find_by!(email: email).devices.count).to eq(1)

      post '/api/v1/auth/mfa/verify', params: { mfa_token: json_body['mfa_token'], code: totp.at(Time.now + 30) }, as: :json
      expect(response).to have_http_status(:ok)
      expect(Device.find(json_body['device_id']).public_key.b).to eq(second.verify_key.to_bytes)
    end
  end

  describe 'email step-up' do
    it 'marks the session verified for an email-only account' do
      token = sign_in_with_email['token']
      expect(email_step_up(token)).to eq(200)
      expect(json_body).to include('step_up_verified' => true, 'method' => 'email')
    end

    it 'refuses a wrong code' do
      token = sign_in_with_email['token']
      post '/api/v1/auth/step-up/email/request', headers: auth_headers(token), as: :json
      post '/api/v1/auth/step-up/email', headers: auth_headers(token), params: { code: '000000' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      post '/api/v1/auth/passkeys/add/options', headers: auth_headers(token), as: :json
      expect(response).to have_http_status(:forbidden)
    end

    it 'is unavailable once the account has a passkey' do
      token = sign_in_with_email['token']
      email_step_up(token)
      add_passkey(token)
      rotated = json_body['rotated_token']

      post '/api/v1/auth/step-up/email/request', headers: auth_headers(rotated), as: :json
      expect(response).to have_http_status(:forbidden)
      expect(json_body).to eq('error' => 'email_step_up_unavailable')
    end

    it 'needs a session' do
      post '/api/v1/auth/step-up/email/request', as: :json
      expect(response).to have_http_status(:unauthorized)
    end
  end
end
