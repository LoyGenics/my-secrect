require 'rails_helper'
require 'rotp'

# Sign in with Google / Apple through the real routes: ID tokens are signed
# with RSA keys generated in the spec and published through a stubbed JWKS
# fetch (spec/support/oauth_helper.rb); device keys are real Ed25519.
RSpec.describe 'Sign in with Google / Apple', type: :request do
  around { |example| with_env(OauthHelper::OAUTH_ENV) { example.run } }
  before { stub_provider_jwks }

  let(:email) { "oauth-#{SecureRandom.hex(4)}@example.test" }

  def json_body = JSON.parse(response.body)

  def oauth_start
    post '/api/v1/auth/oauth/start', as: :json
    expect(response).to have_http_status(:ok)
    json_body
  end

  def oauth_session(provider, ticket:, id_token:, device: nil, **extra)
    post "/api/v1/auth/oauth/#{provider}/session",
         params: { ticket: ticket, id_token: id_token, device: device }.compact.merge(extra), as: :json
  end

  # Start + provider token + session with a fresh device. Returns the body.
  def sign_in_with(provider, key: new_device_key, **token_claims)
    start = oauth_start
    oauth_session(provider, ticket: start['ticket'],
                            id_token: id_token_for(provider, nonce: start['nonce'], **token_claims),
                            device: enroll_proof(key, start['nonce'], platform: 'spec'))
    json_body
  end

  def expect_verification_failed
    expect(response).to have_http_status(:unauthorized)
    expect(json_body).to eq('error' => 'verification_failed')
  end

  describe 'GET /api/v1/auth/providers' do
    it 'lists the configured client ids' do
      get '/api/v1/auth/providers'
      expect(response).to have_http_status(:ok)
      expect(json_body).to eq(
        'google' => { 'web_client_id' => OauthHelper::GOOGLE_WEB, 'ios_client_id' => OauthHelper::GOOGLE_IOS,
                      'android_client_id' => OauthHelper::GOOGLE_ANDROID, 'extension_client_id' => OauthHelper::GOOGLE_EXTENSION },
        'apple' => { 'services_id' => OauthHelper::APPLE_SERVICES, 'bundle_id' => OauthHelper::APPLE_BUNDLE }
      )
    end

    it 'answers null for a provider with no ids' do
      unset = OauthHelper::OAUTH_ENV.transform_values { nil }
      with_env(unset.merge('APPLE_BUNDLE_ID' => OauthHelper::APPLE_BUNDLE)) { get '/api/v1/auth/providers' }
      expect(json_body).to eq('google' => nil, 'apple' => { 'services_id' => nil, 'bundle_id' => OauthHelper::APPLE_BUNDLE })

      with_env(unset) { get '/api/v1/auth/providers' }
      expect(json_body).to eq('google' => nil, 'apple' => nil)
    end
  end

  describe 'POST /api/v1/auth/oauth/start' do
    it 'returns a ticket and a nonce and stores only the ticket digest' do
      body = oauth_start
      expect(body.keys).to eq(%w[ticket nonce expires_at])
      expect(body['ticket']).to match(/\Aot_\h{64}\z/)
      expect(body['nonce']).to match(/\A[A-Za-z0-9_-]{43}\z/)
      expect(Time.iso8601(body['expires_at'])).to be_within(5.seconds).of(10.minutes.from_now)

      record = OauthTicket.sole
      expect(record.ticket_digest).to eq(Digest::SHA256.hexdigest(body['ticket']))
      expect(record.attributes.values.map(&:to_s)).not_to include(body['ticket'], body['nonce'])
    end
  end

  describe 'POST /api/v1/auth/oauth/:provider/session' do
    it 'creates the account, the Google identity and a device-bound session' do
      key = new_device_key
      body = sign_in_with('google', key: key, sub: 'g-123', email: email.upcase)

      expect(response).to have_http_status(:ok)
      user = User.find_by!(email: email)
      expect(body.keys).to eq(%w[token user_id device_id expires_in account_created])
      expect(body).to include('user_id' => user.id, 'expires_in' => Authentication::SessionTokens::TTL_SECONDS,
                              'account_created' => true)
      expect(user.user_identities.pluck(:provider, :subject, :email)).to eq([['google', 'g-123', email]])
      expect(Device.find(body['device_id']).public_key.b).to eq(key.verify_key.to_bytes)
      expect(Session.find_by!(token_digest: Digest::SHA256.hexdigest(body['token'])).device_id).to eq(body['device_id'])
      expect(user.audit_events.pluck(:event_type, :metadata)).to include(['account_created', { 'method' => 'google' }],
                                                                         ['sign_in_succeeded', { 'method' => 'google' }])
    end

    it 'creates the account from Apple (SHA-256 nonce, private relay email, name not stored)' do
      relay = "#{SecureRandom.hex(6)}@privaterelay.appleid.com"
      start = oauth_start
      oauth_session('apple', ticket: start['ticket'], full_name: 'Ada Lovelace',
                             id_token: id_token_for('apple', nonce: start['nonce'], sub: 'a-001.xyz', email: relay))

      expect(response).to have_http_status(:ok)
      expect(json_body).to include('account_created' => true, 'device_id' => nil)
      user = User.find_by!(email: relay)
      expect(user.user_identities.pluck(:provider, :subject)).to eq([%w[apple a-001.xyz]])
      expect(User.column_names.grep(/name/)).to eq([])
    end

    it 'accepts every configured Google client id as audience' do
      [OauthHelper::GOOGLE_IOS, OauthHelper::GOOGLE_ANDROID, OauthHelper::GOOGLE_EXTENSION].each_with_index do |aud, i|
        sign_in_with('google', sub: "g-aud-#{i}", email: "aud#{i}-#{email}", aud: aud, iss: 'accounts.google.com')
        expect(response).to have_http_status(:ok)
      end
      start = oauth_start
      oauth_session('apple', ticket: start['ticket'], id_token: id_token_for('apple', nonce: start['nonce'], aud: OauthHelper::APPLE_SERVICES))
      expect(response).to have_http_status(:ok)
    end

    it 'links a provider to the existing account with the same authoritative email' do
      user = User.create!(email: email)
      body = sign_in_with('google', sub: 'g-link', email: email, hd: 'example.test')

      expect(body).to include('user_id' => user.id, 'account_created' => false)
      expect(User.where(email: email).count).to eq(1)
      expect(user.user_identities.pluck(:provider, :subject)).to eq([%w[google g-link]])

      sign_in_with('apple', sub: 'a-link', email: email)
      expect(json_body['user_id']).to eq(user.id)
      expect(user.user_identities.order(:provider).pluck(:provider)).to eq(%w[apple google])
    end

    it 'finds a linked identity by (provider, sub) even after its email changed' do
      first = sign_in_with('google', sub: 'g-stable', email: email)
      second = sign_in_with('google', sub: 'g-stable', email: "renamed-#{email}")

      expect(second).to include('user_id' => first['user_id'], 'account_created' => false)
      expect(User.where(email: "renamed-#{email}")).not_to exist
      expect(UserIdentity.where(subject: 'g-stable').count).to eq(1)
    end

    it 'links a gmail.com address (Google is authoritative for it)' do
      user = User.create!(email: "g#{SecureRandom.hex(4)}@gmail.com")
      sign_in_with('google', sub: 'g-gmail', email: user.email)
      expect(response).to have_http_status(:ok)
      expect(json_body).to include('user_id' => user.id, 'account_created' => false)
    end

    it 'does not link a non-authoritative Google email to an existing account, nor audit on it' do
      user = User.create!(email: email)
      [{}, { hd: 'other.test' }].each_with_index do |claims, i|
        sign_in_with('google', sub: "g-nonauth-#{i}", email: email, **claims)
        expect_verification_failed
      end
      expect(UserIdentity.count).to eq(0)
      expect(user.audit_events.count).to eq(0)
    end

    it 'creates a new account from a non-authoritative Google email when nobody has it' do
      sign_in_with('google', sub: 'g-new', email: email)
      expect(response).to have_http_status(:ok)
      expect(json_body['account_created']).to be(true)
    end

    it 'with several audiences, requires azp to be a configured client id' do
      audiences = [OauthHelper::GOOGLE_WEB, 'other-app.apps.googleusercontent.test']
      sign_in_with('google', sub: 'g-azp', email: email, aud: audiences, azp: OauthHelper::GOOGLE_IOS)
      expect(response).to have_http_status(:ok)

      [nil, 'other-app.apps.googleusercontent.test'].each do |azp|
        sign_in_with('google', sub: 'g-azp', email: email, aud: audiences, azp: azp)
        expect_verification_failed
      end
    end

    it 'spends the ticket when the ID token fails verification' do
      start = oauth_start
      oauth_session('google', ticket: start['ticket'],
                              id_token: id_token_for('google', nonce: start['nonce'], email: email, key: provider_key('attacker')))
      expect_verification_failed

      oauth_session('google', ticket: start['ticket'], id_token: id_token_for('google', nonce: start['nonce'], email: email))
      expect_verification_failed
      expect(User.where(email: email)).not_to exist
    end

    it 'does not audit a failed token on the account of its email' do
      user = User.create!(email: "g#{SecureRandom.hex(4)}@gmail.com")
      start = oauth_start
      oauth_session('google', ticket: start['ticket'],
                              id_token: id_token_for('google', nonce: start['nonce'], email: user.email, key: provider_key('attacker')))
      expect_verification_failed
      expect(user.audit_events.count).to eq(0)
    end

    it 'does not link by email to an account with a passkey' do
      user = User.create!(email: email)
      Authenticator.create!(user: user, credential_id: SecureRandom.hex(8), public_key: 'pk', sign_count: 1)
      sign_in_with('apple', sub: 'a-passkey', email: email)

      expect_verification_failed
      expect(UserIdentity.count).to eq(0)
      expect(user.audit_events.pluck(:event_type)).to eq(['sign_in_failed'])
    end

    it 'with MFA, answers the MFA challenge and holds the device until the second factor' do
      user = User.create!(email: email)
      secret = Authentication::Totp.enroll(user: user)[:secret]
      totp = ROTP::TOTP.new(secret)
      Authentication::Totp.confirm(user: user, code: totp.now)
      key = new_device_key
      body = sign_in_with('google', key: key, sub: 'g-mfa', email: email, hd: 'example.test')

      expect(response).to have_http_status(:ok)
      expect(body.keys).to eq(%w[mfa_required mfa_token user_id])
      expect(body).to include('mfa_required' => true, 'user_id' => user.id)
      expect(user.devices.count).to eq(0)

      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: totp.at(Time.now + 30) }, as: :json
      expect(response).to have_http_status(:ok)
      expect(Device.find(json_body['device_id']).public_key.b).to eq(key.verify_key.to_bytes)
    end

    it 'issues an unbound session without a device proof (mobile)' do
      start = oauth_start
      oauth_session('google', ticket: start['ticket'], id_token: id_token_for('google', nonce: start['nonce'], email: email))
      expect(response).to have_http_status(:ok)
      expect(json_body).to include('device_id' => nil, 'account_created' => true)
      expect(Session.find_by!(token_digest: Digest::SHA256.hexdigest(json_body['token'])).device_id).to be_nil
      expect(Device.count).to eq(0)
    end

    it 'binds an existing device with a session-bind proof over the nonce' do
      key = new_device_key
      device_id = sign_in_with('google', key: key, sub: 'g-bind', email: email)['device_id']
      start = oauth_start
      oauth_session('google', ticket: start['ticket'], device: bind_proof(key, start['nonce'], device_id),
                              id_token: id_token_for('google', nonce: start['nonce'], sub: 'g-bind', email: email))
      expect(response).to have_http_status(:ok)
      expect(json_body['device_id']).to eq(device_id)
    end

    it 'refuses a bad device proof, creates nothing and keeps the ticket usable' do
      start = oauth_start
      token = id_token_for('google', nonce: start['nonce'], sub: 'g-dev', email: email)
      key = new_device_key
      oauth_session('google', ticket: start['ticket'], id_token: token, device: enroll_proof(key, start['ticket']))

      expect(response).to have_http_status(:unauthorized)
      expect(json_body).to eq('error' => 'device_verification_failed')
      expect(User.where(email: email)).not_to exist
      expect(UserIdentity.count).to eq(0)

      oauth_session('google', ticket: start['ticket'], id_token: token, device: enroll_proof(key, start['nonce']))
      expect(response).to have_http_status(:ok)
    end

    it 'refuses a reused ticket' do
      start = oauth_start
      token = id_token_for('google', nonce: start['nonce'], sub: 'g-once', email: email)
      oauth_session('google', ticket: start['ticket'], id_token: token)
      expect(response).to have_http_status(:ok)

      oauth_session('google', ticket: start['ticket'], id_token: token)
      expect_verification_failed
      expect(Session.where(user_id: User.find_by!(email: email).id).count).to eq(1)
    end

    describe 'refusals (one generic 401, nothing created)' do
      let(:start) { oauth_start }
      let(:nonce) { start['nonce'] }

      after do
        expect_verification_failed
        expect(User.where(email: email)).not_to exist
        expect(UserIdentity.count).to eq(0)
      end

      def refuse(provider = 'google', token)
        oauth_session(provider, ticket: start['ticket'], id_token: token)
      end

      it('bad signature') { refuse(id_token_for('google', nonce: nonce, email: email, key: provider_key('attacker'))) }
      it('alg none') { refuse(JWT.encode({ iss: OauthHelper::ISSUERS['google'], aud: OauthHelper::GOOGLE_WEB, sub: 's', email: email, email_verified: true, iat: Time.now.to_i, exp: Time.now.to_i + 600, nonce: nonce }, nil, 'none')) }
      it('HS256 with the public key as secret') do
        refuse(id_token_for('google', nonce: nonce, email: email, key: provider_key.public_key.to_pem, alg: 'HS256'))
      end
      it('wrong issuer') { refuse(id_token_for('google', nonce: nonce, email: email, iss: 'https://evil.test')) }
      it('Apple issuer on a Google token') { refuse(id_token_for('google', nonce: nonce, email: email, iss: OauthHelper::ISSUERS['apple'])) }
      it('wrong audience') { refuse(id_token_for('google', nonce: nonce, email: email, aud: 'other-app.apps.googleusercontent.test')) }
      it('expired') { refuse(id_token_for('google', nonce: nonce, email: email, iat: 2.hours.ago.to_i, exp: 2.minutes.ago.to_i)) }
      it('issued in the future') { refuse(id_token_for('google', nonce: nonce, email: email, iat: 5.minutes.from_now.to_i)) }
      it('wrong nonce') { refuse(id_token_for('google', nonce: oauth_start['nonce'], email: email)) }
      it('missing nonce') { refuse(id_token_for('google', nonce: nil, email: email)) }
      it('Apple token carrying the raw nonce') { refuse('apple', id_token_for('google', nonce: nonce, email: email, iss: OauthHelper::ISSUERS['apple'], aud: OauthHelper::APPLE_BUNDLE)) }
      it('unverified Google email') { refuse(id_token_for('google', nonce: nonce, email: email, email_verified: false)) }
      it('unverified Apple email') { refuse('apple', id_token_for('apple', nonce: nonce, email: email, email_verified: 'false')) }
      it('unknown kid') { refuse(id_token_for('google', nonce: nonce, email: email, kid: 'kid-unknown')) }
      it('not a JWT') { refuse('not-a-token') }

      it 'expired ticket' do
        token = id_token_for('google', nonce: nonce, email: email)
        OauthTicket.update_all(expires_at: 1.second.ago)
        refuse(token)
      end

      it 'unknown ticket' do
        oauth_session('google', ticket: "ot_#{SecureRandom.hex(32)}", id_token: id_token_for('google', nonce: nonce, email: email))
      end

      it 'provider not configured' do
        with_env('GOOGLE_WEB_CLIENT_ID' => nil, 'GOOGLE_IOS_CLIENT_ID' => nil, 'GOOGLE_ANDROID_CLIENT_ID' => nil,
                 'GOOGLE_EXTENSION_CLIENT_ID' => nil) { refuse(id_token_for('google', nonce: nonce, email: email)) }
      end
    end

    it 'is not routed for another provider' do
      post '/api/v1/auth/oauth/github/session', params: { ticket: 'x', id_token: 'y' }, as: :json
      expect(response).to have_http_status(:not_found)
    end
  end
end
