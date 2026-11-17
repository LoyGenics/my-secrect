require 'rails_helper'
require 'webauthn/fake_client'
require 'tmpdir'

# Email ownership before the first passkey registration — real routes,
# real Action Mailer (:test delivery: the code is read from the delivered
# mail, the only place it exists), real WebAuthn FakeClient attestations.
RSpec.describe 'Sign-up email verification', type: :request do
  include ActiveSupport::Testing::TimeHelpers

  let(:origin) { 'http://localhost:3000' }
  let(:email) { "signup-#{SecureRandom.hex(4)}@example.test" }

  def json_body = JSON.parse(response.body)

  def request_code(address = email)
    post '/api/v1/auth/email/request', params: { email: address }, as: :json
  end

  def verify_code(code, address = email)
    post '/api/v1/auth/email/verify', params: { email: address, code: code }, as: :json
  end

  def wrong_code_for(code) = format('%06d', (code.to_i + 1) % 1_000_000)

  def options_with(ticket, address = email)
    post '/api/v1/auth/passkeys/register', params: { email: address, registration_ticket: ticket }, as: :json
  end

  def attest(options, client: WebAuthn::FakeClient.new(origin), address: email)
    credential = client.create(challenge: options['creation_options']['challenge'], user_verified: true)
    post '/api/v1/auth/passkeys/verify', params: { email: address, credential: credential, kind: 'registration' }, as: :json
  end

  describe 'POST /api/v1/auth/email/request' do
    it 'emails a 6-digit code, stores only its digest, and creates no user' do
      request_code
      expect(response).to have_http_status(:accepted)
      expect(json_body).to eq('status' => 'sent', 'expires_in' => 600)

      code = delivered_code_for(email)
      expect(code).to match(/\A\d{6}\z/)
      record = EmailVerification.find_by!(email: email)
      expect(record.code_digest).to match(/\A\h{64}\z/)
      expect(record.attributes.values.map(&:to_s)).not_to include(code)
      expect(record.expires_at).to be_within(5.seconds).of(10.minutes.from_now)
      expect(User.where(email: email)).not_to exist
    end

    it 'answers identically for an existing account but mails a notice without a code' do
      request_code
      new_status = response.status
      new_body = response.body
      verify_code(delivered_code_for(email))
      options_with(json_body['registration_ticket'])
      attest(json_body)
      expect(response).to have_http_status(:ok)
      ActionMailer::Base.deliveries.clear

      request_code
      expect(response.status).to eq(new_status)
      expect(response.body).to eq(new_body)
      mail = delivered_mails_to(email).last
      expect(mail.subject).to eq('Sign-up attempt for your my-secrect account')
      expect(delivered_code_for(email)).to be_nil
    end

    it 'rejects a malformed address with 422 and sends nothing' do
      request_code('not-an-email')
      expect(response).to have_http_status(:unprocessable_entity)
      expect(json_body['error']).to eq('invalid_email')
      expect(ActionMailer::Base.deliveries).to be_empty
    end

    it 'answers 503 and retires the code when mail cannot be delivered' do
      Dir.mktmpdir do |dir|
        blocker = File.join(dir, 'not-a-directory')
        File.write(blocker, '')
        previous = [ActionMailer::Base.delivery_method, ActionMailer::Base.file_settings]
        # Real :file delivery into a path that cannot be created.
        ActionMailer::Base.delivery_method = :file
        ActionMailer::Base.file_settings = { location: File.join(blocker, 'mails') }
        begin
          request_code
        ensure
          ActionMailer::Base.delivery_method, ActionMailer::Base.file_settings = previous
        end
      end
      expect(response).to have_http_status(:service_unavailable)
      expect(json_body['error']).to eq('email_unavailable')
      expect(EmailVerification.find_by!(email: email).consumed_at).to be_present
    end
  end

  describe 'POST /api/v1/auth/email/verify' do
    it 'returns a single-use ticket for the right code (stored as a digest only)' do
      request_code
      code = delivered_code_for(email)
      verify_code(code)
      expect(response).to have_http_status(:ok)
      ticket = json_body['registration_ticket']
      expect(ticket).to match(/\Art_\h{64}\z/)
      expect(json_body['expires_in']).to eq(600)
      record = EmailVerification.find_by!(email: email)
      expect(record.ticket_digest).to eq(Digest::SHA256.hexdigest(ticket))
      expect(record.verified_at).to be_present

      verify_code(code) # replay of the same code
      expect(response).to have_http_status(:unauthorized)
      expect(json_body).to eq('error' => 'verification_failed')
    end

    it 'rejects a wrong code, and burns the code after 5 failed attempts' do
      request_code
      code = delivered_code_for(email)
      4.times do
        verify_code(wrong_code_for(code))
        expect(response).to have_http_status(:unauthorized)
      end
      expect(EmailVerification.find_by!(email: email).attempts).to eq(4)
      verify_code(wrong_code_for(code)) # 5th failure burns it
      expect(response).to have_http_status(:unauthorized)

      verify_code(code) # even the right code is now useless
      expect(response).to have_http_status(:unauthorized)
      expect(EmailVerification.find_by!(email: email).consumed_at).to be_present
    end

    it 'rejects malformed codes without accepting them as a guess bypass' do
      request_code
      ['', '12345', '1234567', 'abcdef', ' 123456'].each do |bad|
        verify_code(bad)
        expect(response).to have_http_status(:unauthorized)
      end
      expect(EmailVerification.find_by!(email: email).attempts).to eq(5)
    end

    it 'rejects an expired code' do
      request_code
      code = delivered_code_for(email)
      travel 10.minutes + 1.second do
        verify_code(code)
        expect(response).to have_http_status(:unauthorized)
      end
    end

    it 'invalidates the previous code when a new one is requested' do
      request_code
      first = delivered_code_for(email)
      request_code
      second = delivered_code_for(email)
      skip 'the two random codes collided' if first == second

      verify_code(first)
      expect(response).to have_http_status(:unauthorized)
      verify_code(second)
      expect(response).to have_http_status(:ok)
    end

    it 'rejects a code sent to another address' do
      other = "other-#{SecureRandom.hex(4)}@example.test"
      request_code(other)
      request_code
      verify_code(delivered_code_for(other))
      expect(response).to have_http_status(:unauthorized)
    end

    it 'cannot mint a ticket for an existing account (its stored code was never sent)' do
      request_code
      verify_code(delivered_code_for(email))
      options_with(json_body['registration_ticket'])
      attest(json_body)
      request_code # existing account: notice only
      record = EmailVerification.where(email: email).order(:created_at).last
      expect(record.consumed_at).to be_nil
      expect(delivered_code_for(email)).to be_nil
    end
  end

  describe 'POST /api/v1/auth/passkeys/register (ticket required)' do
    it 'refuses options without a ticket, with a bogus ticket, or with a ticket for another address' do
      options_with(nil)
      expect(response).to have_http_status(:unauthorized)
      options_with("rt_#{SecureRandom.hex(32)}")
      expect(response).to have_http_status(:unauthorized)

      ticket = registration_ticket_via_api(email)
      options_with(ticket, "else-#{SecureRandom.hex(4)}@example.test")
      expect(response).to have_http_status(:unauthorized)
      expect(PasskeyChallenge.count).to eq(0)
      expect(User.count).to eq(0)
    end

    it 'refuses an expired ticket' do
      ticket = registration_ticket_via_api(email)
      travel 10.minutes + 1.second do
        options_with(ticket)
        expect(response).to have_http_status(:unauthorized)
      end
    end

    it 'creates the user only after the attestation verifies, then spends the ticket' do
      ticket = registration_ticket_via_api(email)
      options_with(ticket)
      expect(response).to have_http_status(:ok)
      options = json_body
      expect(User.count).to eq(0)
      pending_id = options['user']['id']

      attest(options)
      expect(response).to have_http_status(:ok)
      expect(json_body['token']).to start_with('sess_')
      user = User.find_by!(email: email)
      expect(user.id).to eq(pending_id)
      expect(user.authenticators.count).to eq(1)
      expect(EmailVerification.find_by!(email: email).ticket_consumed_at).to be_present
      expect(AuditEvent.where(user: user, event_type: 'account_created')).to exist

      options_with(ticket) # single use
      expect(response).to have_http_status(:unauthorized)
    end

    it 'keeps the ticket usable when the attestation fails, and creates nothing' do
      ticket = registration_ticket_via_api(email)
      options_with(ticket)
      bad = WebAuthn::FakeClient.new('https://evil.example')
                               .create(challenge: json_body['creation_options']['challenge'], rp_id: 'localhost', user_verified: true)
      post '/api/v1/auth/passkeys/verify', params: { email: email, credential: bad, kind: 'registration' }, as: :json
      expect(response).to have_http_status(:unauthorized)
      expect(User.count).to eq(0)
      expect(EmailVerification.find_by!(email: email).ticket_consumed_at).to be_nil

      options_with(ticket)
      attest(json_body)
      expect(response).to have_http_status(:ok)
      expect(User.where(email: email).count).to eq(1)
    end

    it 'completes an unclaimed leftover row (no passkey, no MFA) under its own id' do
      leftover = User.create!(email: email)
      ticket = registration_ticket_via_api(email)
      options_with(ticket)
      expect(json_body['user']['id']).to eq(leftover.id)
      attest(json_body)
      expect(response).to have_http_status(:ok)
      expect(leftover.reload.authenticators.count).to eq(1)
      expect(User.where(email: email).count).to eq(1)
    end
  end
end
