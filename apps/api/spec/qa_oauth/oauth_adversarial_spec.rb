require 'rails_helper'
require 'webauthn/fake_client'
require 'rotp'
require_relative 'oauth_qa_helper'

# QA (adversarial, uncommitted): Google / Apple sign-in against the contract
# in the auth-contract scratch file. Real routes, real device keys, JWKS
# served by QaOauth's Net::HTTP stub (no network).
RSpec.describe 'QA: OAuth sign-in (adversarial)', type: :request, qa_oauth: true do
  let(:email) { "qa-#{SecureRandom.hex(4)}@example.test" }
  let(:origin) { 'http://localhost:3000' }

  def json_body = JSON.parse(response.body)
  def auth_headers(token) = { 'Authorization' => "Bearer #{token}" }
  def identities_count = ActiveRecord::Base.connection.select_value('SELECT COUNT(*) FROM user_identities').to_i

  def email_user!(address = email)
    ticket = registration_ticket_via_api(address)
    post '/api/v1/auth/email/session',
         params: { email: address, registration_ticket: ticket, device: enroll_proof(new_device_key, ticket) }, as: :json
    expect(response).to have_http_status(:ok)
    json_body['token']
  end

  def email_step_up(token, address = email)
    ActionMailer::Base.deliveries.clear
    post '/api/v1/auth/step-up/email/request', headers: auth_headers(token), as: :json
    post '/api/v1/auth/step-up/email', headers: auth_headers(token), params: { code: delivered_code_for(address) }, as: :json
    expect(response).to have_http_status(:ok)
  end

  # Forged-token refusal: one generic 401 and nothing created.
  def expect_refused(provider, token, start)
    users = User.count
    sessions = Session.count
    oauth_session(provider, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['nonce']))
    expect_generic_401
    expect(User.count).to eq(users)
    expect(Session.count).to eq(sessions)
  end

  describe 'baseline (so the refusals below mean something)' do
    it 'Google: creates the account, the identity and a device-bound session' do
      key = new_device_key
      res, body = oauth_sign_in(:google, email: email, key: key, sub: 'g-baseline')
      expect(res).to have_http_status(:ok)
      user = User.find_by!(email: email)
      expect(body).to include('user_id' => user.id, 'account_created' => true)
      expect(body['token']).to be_present
      expect(Device.find(body['device_id']).public_key.b).to eq(key.verify_key.to_bytes)
      expect(identities_count).to eq(1)
    end

    it 'Apple: accepts nonce = sha256(raw nonce) and either Apple audience' do
      res, = oauth_sign_in(:apple, email: email, aud: QaOauth::APPLE_SERVICES)
      expect(res).to have_http_status(:ok)
      expect(User.find_by(email: email)).to be_present
    end

    it 'Google: every configured client id is an accepted audience' do
      [QaOauth::GOOGLE_IOS, QaOauth::GOOGLE_ANDROID, QaOauth::GOOGLE_EXTENSION].each_with_index do |aud, i|
        res, = oauth_sign_in(:google, email: "aud#{i}-#{email}", aud: aud, azp: aud)
        expect(res).to have_http_status(:ok), "aud #{aud} refused"
      end
    end

    it 'GET auth/providers exposes only the public client ids' do
      get '/api/v1/auth/providers', as: :json
      expect(response).to have_http_status(:ok)
      expect(json_body).to eq(
        'google' => { 'web_client_id' => QaOauth::GOOGLE_WEB, 'ios_client_id' => QaOauth::GOOGLE_IOS,
                      'android_client_id' => QaOauth::GOOGLE_ANDROID, 'extension_client_id' => QaOauth::GOOGLE_EXTENSION },
        'apple' => { 'services_id' => QaOauth::APPLE_SERVICES, 'bundle_id' => QaOauth::APPLE_BUNDLE }
      )
    end

    it 'GET auth/providers returns null for an unconfigured provider, and its session endpoint refuses' do
      ENV.delete('APPLE_SERVICES_ID')
      ENV.delete('APPLE_BUNDLE_ID')
      get '/api/v1/auth/providers', as: :json
      expect(json_body['apple']).to be_nil
      start = oauth_start
      expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email), start)
    end
  end

  describe 'signature / algorithm attacks' do
    it 'refuses alg=none' do
      start = oauth_start
      claims = google_claims(nonce: start['nonce'], email: email)
      expect_refused(:google, build_jwt({ alg: 'none', kid: QaOauth::KIDS[:google], typ: 'JWT' }, claims, key: nil), start)
    end

    it 'refuses alg=none with a stripped signature segment' do
      start = oauth_start
      token = build_jwt({ alg: 'none', typ: 'JWT' }, google_claims(nonce: start['nonce'], email: email), key: nil)
      expect_refused(:google, token.sub(/\.\z/, ''), start)
    end

    it 'refuses HS256 signed with the provider public key (PEM, DER and JWK n) — key confusion' do
      pub = QaOauth::KEYS[:google].public_key
      [pub.to_pem, pub.to_der, QaOauth::KEYS[:google].n.to_s(2), QaOauth.jwks_json(:google)].each do |secret|
        start = oauth_start
        token = build_jwt({ alg: 'HS256', kid: QaOauth::KIDS[:google], typ: 'JWT' },
                          google_claims(nonce: start['nonce'], email: email), key: secret)
        expect_refused(:google, token, start)
      end
    end

    it 'refuses RS384/RS512 (RS256 only)' do
      %w[RS384 RS512].each do |alg|
        start = oauth_start
        expect_refused(:google, google_token(nonce: start['nonce'], email: email, header: { alg: alg }), start)
      end
    end

    it 'refuses a tampered payload (valid signature of other claims)' do
      start = oauth_start
      token = google_token(nonce: start['nonce'], email: "victim-#{email}", email_verified: false)
      h, _p, s = token.split('.')
      forged = qa_b64(JSON.generate(google_claims(nonce: start['nonce'], email: "victim-#{email}")))
      expect_refused(:google, [h, forged, s].join('.'), start)
    end

    it 'refuses a token signed by an unknown key under the provider kid' do
      start = oauth_start
      claims = google_claims(nonce: start['nonce'], email: email)
      token = build_jwt({ alg: 'RS256', kid: QaOauth::KIDS[:google] }, claims, key: QaOauth::KEYS[:attacker])
      expect_refused(:google, token, start)
    end

    it 'refuses an unknown kid' do
      start = oauth_start
      claims = google_claims(nonce: start['nonce'], email: email)
      expect_refused(:google, build_jwt({ alg: 'RS256', kid: 'no-such-kid' }, claims, key: QaOauth::KEYS[:google]), start)
    end

    it 'never follows jku / x5u / jwk headers (no SSRF, no embedded keys)' do
      start = oauth_start
      claims = google_claims(nonce: start['nonce'], email: email)
      jku = "https://#{QaOauth::ATTACKER_HOST}/jwks.json"
      token = build_jwt({ alg: 'RS256', kid: QaOauth::KIDS[:attacker], jku: jku, x5u: jku, jwk: QaOauth.jwk(:attacker) },
                        claims, key: QaOauth::KEYS[:attacker])
      expect_refused(:google, token, start)
      expect(QaOauth.requests.map { |r| r[:host] }).not_to include(QaOauth::ATTACKER_HOST)
    end

    it 'never fetches anything but the fixed Google / Apple key URLs, whatever the kid' do
      ["https://#{QaOauth::ATTACKER_HOST}/k", "../../#{QaOauth::ATTACKER_HOST}", "@#{QaOauth::ATTACKER_HOST}/x", "a\r\nHost: #{QaOauth::ATTACKER_HOST}"].each do |kid|
        start = oauth_start
        claims = google_claims(nonce: start['nonce'], email: email)
        expect_refused(:google, build_jwt({ alg: 'RS256', kid: kid }, claims, key: QaOauth::KEYS[:attacker]), start)
      end
      start = oauth_start
      expect_refused(:apple, signed(:apple, apple_claims(raw_nonce: start['nonce'], email: email), header: { kid: "https://#{QaOauth::ATTACKER_HOST}/" }), start)
      allowed = %w[www.googleapis.com accounts.google.com appleid.apple.com]
      expect(QaOauth.requests.map { |r| r[:host] }.uniq - allowed).to eq([])
      expect(QaOauth.requests.map { |r| r[:url] }).to all(start_with('https://'))
    end

    it 'refuses malformed tokens with a 401, never a 500' do
      start = oauth_start
      ['', 'abc', 'a.b.c', '...', "#{qa_b64('{')}.#{qa_b64('{}')}.", 'x' * 20_000, nil].each do |bad|
        oauth_session(:google, ticket: start['ticket'], id_token: bad, device: enroll_proof(new_device_key, start['nonce']))
        expect(response.status).to eq(401), "id_token #{bad.inspect[0, 40]} -> #{response.status}"
      end
      oauth_session(:google, ticket: start['ticket'], id_token: { 'a' => 1 }, device: enroll_proof(new_device_key, start['nonce']))
      expect(response.status).to eq(401)
    end

    it 'JWKS endpoint down: no 500, nothing issued' do
      QaOauth.jwks_down = true
      start = oauth_start
      claims = google_claims(nonce: start['nonce'], email: email)
      oauth_session(:google, ticket: start['ticket'], id_token: build_jwt({ alg: 'RS256', kid: "rotated-#{SecureRandom.hex(3)}" }, claims, key: QaOauth::KEYS[:google]),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect([401, 503]).to include(response.status)
      expect(Session.count).to eq(0)
      fetches = QaOauth.requests.count { |r| r[:path] == '/oauth2/v3/certs' }
      3.times do
        s2 = oauth_start
        c2 = google_claims(nonce: s2['nonce'], email: email)
        oauth_session(:google, ticket: s2['ticket'], id_token: signed(:google, c2), device: enroll_proof(new_device_key, s2['nonce']))
        expect([401, 503]).to include(response.status)
      end
      expect(QaOauth.requests.count { |r| r[:path] == '/oauth2/v3/certs' }).to eq(fetches) # failure backoff: no refetch storm
    end
  end

  describe 'claim checks' do
    it 'refuses a token for another app (aud = someone else\'s Google client)' do
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, aud: QaOauth::OTHER_APP_GOOGLE, azp: QaOauth::OTHER_APP_GOOGLE), start)
    end

    it 'refuses an Apple-audience token at Google and a Google client id at Apple' do
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, aud: QaOauth::APPLE_BUNDLE), start)
      start = oauth_start
      expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email, aud: QaOauth::GOOGLE_WEB), start)
    end

    it 'refuses a missing aud and an aud array that does not contain ours' do
      start = oauth_start
      claims = google_claims(nonce: start['nonce'], email: email).except(:aud)
      expect_refused(:google, signed(:google, claims), start)
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, aud: [QaOauth::OTHER_APP_GOOGLE]), start)
    end

    it 'multi-audience token: azp foreign or missing -> 401; azp ours -> 200' do
      multi = [QaOauth::GOOGLE_WEB, QaOauth::OTHER_APP_GOOGLE]
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, aud: multi, azp: QaOauth::OTHER_APP_GOOGLE), start)
      start = oauth_start
      expect_refused(:google, signed(:google, google_claims(nonce: start['nonce'], email: email, aud: multi).except(:azp)), start)
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, aud: multi, azp: ''), start)
      res, = oauth_sign_in(:google, email: email, aud: multi, azp: QaOauth::GOOGLE_IOS)
      expect(res).to have_http_status(:ok)
    end

    it 'refuses spoofed issuers' do
      ['https://evil.example', 'https://accounts.google.com.evil.example', 'accounts.google.com/', 'https://appleid.apple.com', nil].each do |iss|
        start = oauth_start
        expect_refused(:google, google_token(nonce: start['nonce'], email: email, iss: iss), start)
      end
      ['https://accounts.google.com', 'appleid.apple.com', 'https://appleid.apple.com.evil.example'].each do |iss|
        start = oauth_start
        expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email, iss: iss), start)
      end
    end

    it 'accepts the bare accounts.google.com issuer (contract)' do
      res, = oauth_sign_in(:google, email: email, iss: 'accounts.google.com')
      expect(res).to have_http_status(:ok)
    end

    it 'refuses a token from the other provider (cross-provider key/iss)' do
      start = oauth_start
      expect_refused(:google, apple_token(raw_nonce: start['nonce'], email: email, nonce: start['nonce'], aud: QaOauth::GOOGLE_WEB), start)
      start = oauth_start
      expect_refused(:apple, google_token(nonce: Digest::SHA256.hexdigest(start['nonce']), email: email, aud: QaOauth::APPLE_BUNDLE), start)
    end

    it 'refuses expired, missing-exp and future-dated tokens' do
      [{ exp: now_i - 600, iat: now_i - 4200 }, { exp: nil }, { iat: now_i + 3600, exp: now_i + 7200 },
       { nbf: now_i + 3600 }, { exp: 'never' }].each do |over|
        start = oauth_start
        claims = google_claims(nonce: start['nonce'], email: email, **over).compact
        expect_refused(:google, signed(:google, claims), start)
      end
    end

    it 'refuses a token without sub' do
      start = oauth_start
      expect_refused(:google, signed(:google, google_claims(nonce: start['nonce'], email: email).except(:sub)), start)
    end
  end

  describe 'nonce and ticket' do
    it 'refuses a nonce from another ticket' do
      a = oauth_start
      b = oauth_start
      expect_refused(:google, google_token(nonce: b['nonce'], email: email), a)
    end

    it 'refuses a missing nonce' do
      start = oauth_start
      expect_refused(:google, signed(:google, google_claims(nonce: start['nonce'], email: email).except(:nonce)), start)
    end

    it 'Google wants the RAW nonce, not its hash' do
      start = oauth_start
      expect_refused(:google, google_token(nonce: Digest::SHA256.hexdigest(start['nonce']), email: email), start)
    end

    it 'Apple wants sha256(raw nonce): the raw nonce, an uppercase or base64 digest are refused' do
      start = oauth_start
      expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email, nonce: start['nonce']), start)
      start = oauth_start
      expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email, nonce: Digest::SHA256.hexdigest(start['nonce']).upcase), start)
      start = oauth_start
      expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email, nonce: Digest::SHA256.base64digest(start['nonce'])), start)
    end

    it 'spends the ticket: replay of the same ticket + token is refused' do
      start = oauth_start
      token = google_token(nonce: start['nonce'], email: email)
      oauth_session(:google, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['nonce']))
      expect(response).to have_http_status(:ok)
      oauth_session(:google, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['nonce']))
      expect_generic_401
    end

    it 'a ticket spent at Google cannot be reused at Apple' do
      start = oauth_start
      oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect(response).to have_http_status(:ok)
      oauth_session(:apple, ticket: start['ticket'], id_token: apple_token(raw_nonce: start['nonce'], email: "b-#{email}"),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect_generic_401
      expect(User.find_by(email: "b-#{email}")).to be_nil
    end

    it 'a ticket burned by a failed token check cannot be retried with a good token' do
      start = oauth_start
      oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email, aud: QaOauth::OTHER_APP_GOOGLE),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect_generic_401
      oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect_generic_401
      expect(User.find_by(email: email)).to be_nil
    end

    it 'a bad device proof does NOT spend the ticket (retry with a good proof succeeds)' do
      start = oauth_start
      token = google_token(nonce: start['nonce'], email: email)
      oauth_session(:google, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['ticket']))
      expect_generic_401('device_verification_failed')
      oauth_session(:google, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['nonce']))
      expect(response).to have_http_status(:ok)
    end

    it 'refuses an expired ticket (10-minute TTL)' do
      start = oauth_start
      travel 11.minutes do
        expect_refused(:google, google_token(nonce: start['nonce'], email: email), start)
      end
    end

    it 'refuses an unknown or missing ticket' do
      start = oauth_start
      token = google_token(nonce: start['nonce'], email: email)
      ['ot_does-not-exist', start['nonce'], '', nil].each do |ticket|
        oauth_session(:google, ticket: ticket, id_token: token, device: enroll_proof(new_device_key, start['nonce']))
        expect(response.status).to eq(401), "ticket #{ticket.inspect} -> #{response.status}"
      end
    end

    it 'stores neither the raw nonce nor the ticket nor the id_token' do
      start = oauth_start
      token = google_token(nonce: start['nonce'], email: email)
      oauth_session(:google, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['nonce']))
      expect(response).to have_http_status(:ok)
      conn = ActiveRecord::Base.connection
      hits = conn.tables.flat_map do |table|
        cols = conn.columns(table).select { |c| %i[string text].include?(c.type) }.map(&:name)
        model = Class.new(ActiveRecord::Base) { self.table_name = table }
        cols.flat_map do |col|
          [start['nonce'], token].select { |secret| model.where(col => secret).exists? }.map { "#{table}.#{col}" }
        end
      end
      expect(hits).to eq([])
    end

    it 'start issues a fresh, high-entropy nonce and ticket each time' do
      a = oauth_start
      b = oauth_start
      expect(a['nonce']).not_to eq(b['nonce'])
      expect(a['ticket']).not_to eq(b['ticket'])
      expect(a['nonce'].length).to be >= 32
      expect(a['nonce']).to match(/\A[\x21\x23-\x5B\x5D-\x7E]+\z/) # signable in a device proof
      expires = a['expires_at'].is_a?(Numeric) ? Time.zone.at(a['expires_at']) : Time.zone.parse(a['expires_at'].to_s)
      expect(expires).to be_within(30.seconds).of(10.minutes.from_now)
    end
  end

  describe 'account linking and takeover' do
    it 'an unverified Google email cannot claim an existing account' do
      email_user!
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, email_verified: false), start)
      expect(identities_count).to eq(0)
    end

    it 'an unverified Google email cannot create an account either (contract: email_verified true)' do
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, email_verified: false), start)
      start = oauth_start
      expect_refused(:google, signed(:google, google_claims(nonce: start['nonce'], email: email).except(:email_verified)), start)
    end

    it 'string "false" / missing Apple email_verified cannot claim an existing account' do
      email_user!
      %w[false False 0].each do |v|
        start = oauth_start
        expect_refused(:apple, apple_token(raw_nonce: start['nonce'], email: email, email_verified: v), start)
      end
      start = oauth_start
      expect_refused(:apple, signed(:apple, apple_claims(raw_nonce: start['nonce'], email: email).except(:email_verified)), start)
      expect(identities_count).to eq(0)
    end

    it 'Google email_verified "false" as a string is not truthy' do
      email_user!
      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email, email_verified: 'false'), start)
    end

    it 'email case/whitespace tricks do not create a second account or bypass verification' do
      email_user!
      res, body = oauth_sign_in(:google, email: "  #{email.upcase} ")
      expect([200, 401]).to include(res.status)
      expect(body['account_created']).to be(false) if res.status == 200
      expect(User.where(email: email).count).to eq(1)
      expect(User.count).to eq(1)
    end

    it 'links a verified Google email to an existing email-code account (contract) without creating a user' do
      email_user!
      res, body = oauth_sign_in(:google, email: email)
      expect(res).to have_http_status(:ok)
      expect(body['user_id']).to eq(User.find_by!(email: email).id)
      expect(body['account_created']).to be(false)
      expect(identities_count).to eq(1)
    end

    it 'a second provider links to the same user' do
      _, google = oauth_sign_in(:google, email: email, sub: "g-#{SecureRandom.hex(3)}")
      res, apple = oauth_sign_in(:apple, email: email)
      expect(res).to have_http_status(:ok)
      expect(apple['user_id']).to eq(google['user_id'])
      expect(apple['account_created']).to be(false)
      expect(identities_count).to eq(2)
    end

    it '(provider, sub) wins over email: same sub with a changed email signs in the same user' do
      sub = "g-#{SecureRandom.hex(4)}"
      _, first = oauth_sign_in(:google, email: email, sub: sub)
      res, again = oauth_sign_in(:google, email: "changed-#{email}", sub: sub)
      expect(res).to have_http_status(:ok)
      expect(again['user_id']).to eq(first['user_id'])
      expect(User.find_by(email: "changed-#{email}")).to be_nil
    end

    it 'the identity lookup is scoped to the provider: an Apple sub equal to a Google sub is another person' do
      sub = "shared-#{SecureRandom.hex(4)}"
      _, google = oauth_sign_in(:google, email: email, sub: sub)
      res, apple = oauth_sign_in(:apple, email: "other-#{email}", sub: sub)
      expect(res).to have_http_status(:ok)
      expect(apple['user_id']).not_to eq(google['user_id'])
    end

    it 'a known (provider, sub) cannot be re-pointed by presenting another verified email (no identity hijack)' do
      sub = "g-#{SecureRandom.hex(4)}"
      _, first = oauth_sign_in(:google, email: email, sub: sub)
      victim_token = email_user!("victim-#{email}")
      expect(victim_token).to be_present
      _, again = oauth_sign_in(:google, email: "victim-#{email}", sub: sub)
      expect(again['user_id']).to eq(first['user_id'])
      expect(again['user_id']).not_to eq(User.find_by!(email: "victim-#{email}").id)
    end

    it 'Apple private relay emails are accepted as-is and never merged with the real address' do
      relay = "#{SecureRandom.hex(5)}@privaterelay.appleid.com"
      email_user!
      res, body = oauth_sign_in(:apple, email: relay, is_private_email: 'true')
      expect(res).to have_http_status(:ok)
      expect(body['account_created']).to be(true)
      expect(body['user_id']).not_to eq(User.find_by!(email: email).id)
      expect(User.find(body['user_id']).email).to eq(relay)
    end

    it 'a token without an email claim never creates or links an account by email' do
      sub = "001111.#{SecureRandom.hex(6)}.0001"
      _, first = oauth_sign_in(:apple, email: email, sub: sub)
      start = oauth_start
      oauth_session(:apple, ticket: start['ticket'], id_token: signed(:apple, apple_claims(raw_nonce: start['nonce'], email: nil, sub: sub).except(:email, :email_verified)),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect([200, 401]).to include(response.status) # known sub: either is acceptable
      expect(json_body['user_id']).to eq(first['user_id']) if response.status == 200
      start = oauth_start
      expect_refused(:apple, signed(:apple, apple_claims(raw_nonce: start['nonce'], email: nil).except(:email, :email_verified)), start)
    end

    it 'non-authoritative Google email (no hd, not Gmail) cannot link an existing account: 401, no identity, no audit on the victim' do
      email_user!
      victim = User.find_by!(email: email)
      audits = victim.audit_events.count
      start = oauth_start
      expect_refused(:google, signed(:google, google_claims(nonce: start['nonce'], email: email).except(:hd)), start)
      expect(identities_count).to eq(0)
      expect(victim.audit_events.count).to eq(audits)
    end

    it 'hd spoof: a Workspace hd for a DIFFERENT domain is not authoritative for the email' do
      email_user!
      %w[evil.example example.test.evil.example test].each do |hd|
        start = oauth_start
        expect_refused(:google, google_token(nonce: start['nonce'], email: email, hd: hd), start)
      end
      expect(identities_count).to eq(0)
    end

    it 'a non-authoritative Google email may still create a NEW account' do
      res, body = oauth_sign_in(:google, email: "fresh-#{email}", hd: nil)
      expect(res).to have_http_status(:ok)
      expect(body['account_created']).to be(true)
    end

    it 'Gmail without hd is authoritative and links' do
      gmail = "qa.#{SecureRandom.hex(4)}@gmail.com"
      email_user!(gmail)
      res, body = oauth_sign_in(:google, email: gmail.upcase, hd: nil)
      expect(res).to have_http_status(:ok)
      expect(body['user_id']).to eq(User.find_by!(email: gmail).id)
    end

    it 'a known (provider, sub) still signs in even when its email is non-authoritative' do
      sub = "g-#{SecureRandom.hex(4)}"
      _, first = oauth_sign_in(:google, email: "nonauth-#{email}", sub: sub, hd: nil)
      res, again = oauth_sign_in(:google, email: "nonauth-#{email}", sub: sub, hd: nil)
      expect(res).to have_http_status(:ok)
      expect(again['user_id']).to eq(first['user_id'])
    end

    it 'Apple verified non-relay email is trusted and links an existing account' do
      email_user!
      res, body = oauth_sign_in(:apple, email: email)
      expect(res).to have_http_status(:ok)
      expect(body['user_id']).to eq(User.find_by!(email: email).id)
    end

    it 'a passkey account (email-code sign-in closed, device-identity §6.3) is not opened by a Google email match' do
      token = email_user!
      email_step_up(token)
      client = WebAuthn::FakeClient.new(origin)
      post '/api/v1/auth/passkeys/add/options', headers: auth_headers(token), as: :json
      credential = client.create(challenge: json_body['creation_options']['challenge'], user_verified: true)
      post '/api/v1/auth/passkeys/add/verify', headers: auth_headers(token), params: { credential: credential }, as: :json
      expect(response).to have_http_status(:created)

      start = oauth_start
      expect_refused(:google, google_token(nonce: start['nonce'], email: email), start)
    end

    it 'full_name is optional and a hostile value cannot break the request' do
      start = oauth_start
      oauth_session(:apple, ticket: start['ticket'], id_token: apple_token(raw_nonce: start['nonce'], email: email),
                    device: enroll_proof(new_device_key, start['nonce']), full_name: { 'givenName' => '<script>', 'x' => 'y' * 10_000 })
      expect([200, 401, 422]).to include(response.status)
    end
  end

  describe 'MFA and device proof' do
    it 'an MFA-enabled user gets the MFA challenge, not a session, and no device yet' do
      token = email_user!
      email_step_up(token)
      post '/api/v1/auth/mfa/enroll', headers: auth_headers(token), as: :json
      totp = ROTP::TOTP.new(json_body['secret'])
      post '/api/v1/auth/mfa/confirm', headers: auth_headers(token), params: { code: totp.now }, as: :json
      expect(response).to have_http_status(:ok)
      devices = User.find_by!(email: email).devices.count

      key = new_device_key
      res, body = oauth_sign_in(:google, email: email, key: key)
      expect(res).to have_http_status(:ok)
      expect(body).to include('mfa_required' => true)
      expect(body).not_to have_key('token')
      expect(User.find_by!(email: email).devices.count).to eq(devices)

      post '/api/v1/auth/mfa/verify', params: { mfa_token: body['mfa_token'], code: totp.at(Time.now + 30) }, as: :json
      expect(response).to have_http_status(:ok)
      expect(Device.find(json_body['device_id']).public_key.b).to eq(key.verify_key.to_bytes)
    end

    it 'device proof is optional (orchestrator decision): no device -> 200 unbound session' do
      start = oauth_start
      oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email), device: nil)
      expect(response).to have_http_status(:ok)
      expect(json_body['device_id']).to be_nil
      expect(Session.find_by!(token_digest: Digest::SHA256.hexdigest(json_body['token'])).device_id).to be_nil
    end

    it 'the device proof must be signed over THIS nonce (not the ticket, not another nonce)' do
      other = oauth_start
      start = oauth_start
      token = google_token(nonce: start['nonce'], email: email)
      key = new_device_key
      [enroll_proof(key, start['ticket']), enroll_proof(key, other['nonce']), enroll_proof(key, Digest::SHA256.hexdigest(start['nonce'])),
       { public_key: device_public_key(key), signature: qa_b64('x' * 64) }].each do |proof|
        oauth_session(:google, ticket: start['ticket'], id_token: token, device: proof)
        expect_generic_401('device_verification_failed')
        expect(User.find_by(email: email)).to be_nil
      end
    end

    it 'a bind proof for a device of ANOTHER user is refused' do
      _, victim = oauth_sign_in(:google, email: "victim-#{email}")
      victim_device = victim['device_id']
      start = oauth_start
      oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email),
                    device: bind_proof(new_device_key, start['nonce'], victim_device))
      expect_generic_401('device_verification_failed')
    end

    it 'binds an existing device of the same user with a bind proof over the nonce' do
      key = new_device_key
      _, first = oauth_sign_in(:google, email: email, key: key, sub: 'g-bind')
      start = oauth_start
      oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email, sub: 'g-bind'),
                    device: bind_proof(key, start['nonce'], first['device_id']))
      expect(response).to have_http_status(:ok)
      expect(json_body['device_id']).to eq(first['device_id'])
    end
  end

  describe 'errors are not an oracle' do
    it 'unknown provider is a 404/401, not a 500' do
      start = oauth_start
      oauth_session(:github, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], email: email),
                    device: enroll_proof(new_device_key, start['nonce']))
      expect([401, 404]).to include(response.status)
    end

    it 'existing vs new email, bad aud vs bad signature: identical bodies' do
      email_user!
      bodies = []
      [{ email: email, email_verified: false }, { email: "new-#{email}", email_verified: false },
       { email: email, aud: QaOauth::OTHER_APP_GOOGLE }].each do |over|
        start = oauth_start
        oauth_session(:google, ticket: start['ticket'], id_token: google_token(nonce: start['nonce'], **over),
                      device: enroll_proof(new_device_key, start['nonce']))
        bodies << [response.status, response.body]
      end
      expect(bodies.uniq.size).to eq(1), bodies.inspect
    end
  end

  describe 'rate limits' do
    around do |example|
      previous = Rack::Attack.enabled
      Rack::Attack.enabled = true
      Rack::Attack.reset!
      example.run
    ensure
      Rack::Attack.reset!
      Rack::Attack.enabled = previous
    end

    it 'throttles auth/oauth/start per IP well below the global API limit' do
      statuses = Array.new(40) { post('/api/v1/auth/oauth/start', params: {}, as: :json) }
      expect(statuses).to include(429)
    end

    it 'throttles auth/oauth/:provider/session per IP well below the global API limit' do
      statuses = Array.new(40) do |i|
        provider = i.even? ? 'google' : 'apple'
        post("/api/v1/auth/oauth/#{provider}/session", params: { ticket: 'x', id_token: 'a.b.c' }, as: :json)
      end
      expect(statuses).to include(429)
    end
  end

  describe 'logging' do
    around do |example|
      @log_io = StringIO.new
      capture = ActiveSupport::Logger.new(@log_io)
      capture.level = :debug
      Rails.logger.broadcast_to(capture)
      example.run
    ensure
      Rails.logger.stop_broadcasting_to(capture)
    end

    it 'filter_parameters redact id_token, nonce, ticket and device signature' do
      filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)
      out = filter.filter('id_token' => 'T', 'nonce' => 'N', 'ticket' => 'K',
                          'device' => { 'signature' => 'S', 'public_key' => 'P' })
      expect(out).to eq('id_token' => '[FILTERED]', 'nonce' => '[FILTERED]', 'ticket' => '[FILTERED]',
                        'device' => { 'signature' => '[FILTERED]', 'public_key' => '[FILTERED]' })
    end

    it 'filter_parameters redact full_name (PII, low)' do
      filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)
      expect(filter.filter('full_name' => 'F')).to eq('full_name' => '[FILTERED]')
    end

    it 'no id_token, nonce, ticket, sub or email in the log or audit metadata' do
      start = oauth_start
      sub = "g-#{SecureRandom.hex(6)}"
      token = google_token(nonce: start['nonce'], email: email, sub: sub)
      oauth_session(:google, ticket: start['ticket'], id_token: token, device: enroll_proof(new_device_key, start['nonce']))
      expect(response).to have_http_status(:ok)
      start2 = oauth_start
      bad = google_token(nonce: start2['nonce'], email: email, aud: QaOauth::OTHER_APP_GOOGLE)
      oauth_session(:google, ticket: start2['ticket'], id_token: bad, device: enroll_proof(new_device_key, start2['nonce']))

      log = @log_io.string
      audit = AuditEvent.all.map { |e| e.metadata.to_json }.join
      [token, token.split('.')[1], token.split('.')[2], bad, start['nonce'], start['ticket'], start2['nonce'], start2['ticket'],
       Digest::SHA256.hexdigest(start['nonce'])].each do |secret|
        expect(log).not_to include(secret)
        expect(audit).not_to include(secret)
      end
      expect(audit).not_to include(email)
    end

    it 'fetches keys with bounded timeouts and does not refetch per unknown kid' do
      oauth_sign_in(:google, email: email)
      8.times do
        start = oauth_start
        claims = google_claims(nonce: start['nonce'], email: email)
        oauth_session(:google, ticket: start['ticket'], id_token: build_jwt({ alg: 'RS256', kid: "rnd-#{SecureRandom.hex(4)}" }, claims, key: QaOauth::KEYS[:google]),
                      device: enroll_proof(new_device_key, start['nonce']))
      end
      fetches = QaOauth.requests.select { |r| r[:host] }
      expect(fetches).not_to be_empty
      fetches.each do |r|
        expect(r[:open_timeout].to_f).to be_between(0.1, 10), r.inspect
        expect(r[:read_timeout].to_f).to be_between(0.1, 10), r.inspect
      end
      expect(fetches.count { |r| r[:path] =~ /certs|keys/ }).to be <= 3, fetches.map { |r| r[:url] }.inspect
    end
  end
end
