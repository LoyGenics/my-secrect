require 'base64'
require 'json'
require 'net/http'
require 'openssl'
require 'securerandom'

# QA harness for the Google/Apple sign-in specs (adversarial, implementation
# agnostic). Two pieces:
#
#   * QaOauth::NetHttpStub — while QaOauth.active, every Net::HTTP request
#     (Net::HTTP.get, Net::HTTP#start/request, open-uri, Faraday's net_http
#     adapter) is answered from a fixed table instead of the network and
#     recorded with its timeouts. Nothing ever leaves the machine. Unknown
#     hosts get a 404, except attacker.qa.test which serves the ATTACKER's
#     JWKS (so following a jku/x5u header would make a forged token verify).
#   * Token builders: RS256 tokens signed with QA RSA keys published in the
#     stubbed Google/Apple JWKS, plus forged variants (alg none, HS256 with
#     the public key, unknown kid, ...).
module QaOauth
  GOOGLE_WEB = 'qa-web.apps.googleusercontent.com'.freeze
  GOOGLE_IOS = 'qa-ios.apps.googleusercontent.com'.freeze
  GOOGLE_ANDROID = 'qa-android.apps.googleusercontent.com'.freeze
  GOOGLE_EXTENSION = 'qa-extension.apps.googleusercontent.com'.freeze
  APPLE_SERVICES = 'com.qa.mysecret.web'.freeze
  APPLE_BUNDLE = 'com.qa.mysecret.app'.freeze
  OTHER_APP_GOOGLE = 'evil-app.apps.googleusercontent.com'.freeze

  ENV_VARS = {
    'GOOGLE_WEB_CLIENT_ID' => GOOGLE_WEB, 'GOOGLE_IOS_CLIENT_ID' => GOOGLE_IOS,
    'GOOGLE_ANDROID_CLIENT_ID' => GOOGLE_ANDROID, 'GOOGLE_EXTENSION_CLIENT_ID' => GOOGLE_EXTENSION,
    'APPLE_SERVICES_ID' => APPLE_SERVICES, 'APPLE_BUNDLE_ID' => APPLE_BUNDLE
  }.freeze

  KEYS = { google: OpenSSL::PKey::RSA.generate(2048), apple: OpenSSL::PKey::RSA.generate(2048),
           attacker: OpenSSL::PKey::RSA.generate(2048) }.freeze
  RUN = SecureRandom.hex(4)
  KIDS = { google: "qa-google-#{RUN}", apple: "qa-apple-#{RUN}", attacker: "qa-attacker-#{RUN}" }.freeze

  ATTACKER_HOST = 'attacker.qa.test'.freeze

  class << self
    attr_accessor :active, :jwks_down
    def requests = (@requests ||= [])
    def reset! = (@requests = []; @jwks_down = false)
  end

  module_function

  def b64(bytes) = Base64.urlsafe_encode64(bytes, padding: false)

  def jwk(name)
    key = KEYS.fetch(name)
    { kty: 'RSA', use: 'sig', alg: 'RS256', kid: KIDS.fetch(name),
      n: b64(key.n.to_s(2)), e: b64(key.e.to_s(2)) }
  end

  def cert(name)
    key = KEYS.fetch(name)
    c = OpenSSL::X509::Certificate.new
    c.version = 2
    c.serial = 1
    c.subject = c.issuer = OpenSSL::X509::Name.parse("/CN=qa-#{name}")
    c.public_key = key.public_key
    c.not_before = Time.now - 3600
    c.not_after = Time.now + 86_400
    c.sign(key, OpenSSL::Digest.new('SHA256'))
    c.to_pem
  end

  def jwks_json(name) = JSON.generate(keys: [jwk(name)])

  # [status, body] for a requested URL.
  def respond_to_url(host, path)
    jwks_paths = { 'www.googleapis.com' => { '/oauth2/v3/certs' => :google },
                   'appleid.apple.com' => { '/auth/keys' => :apple } }
    if (name = jwks_paths.dig(host, path))
      return [503, '{"error":"down"}'] if jwks_down
      return [200, jwks_json(name)]
    end
    return [200, JSON.generate(KIDS[:google] => cert(:google))] if host == 'www.googleapis.com' && path == '/oauth2/v1/certs'
    if path == '/.well-known/openid-configuration'
      return [200, JSON.generate(issuer: 'https://accounts.google.com', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs')] if host == 'accounts.google.com'
      return [200, JSON.generate(issuer: 'https://appleid.apple.com', jwks_uri: 'https://appleid.apple.com/auth/keys')] if host == 'appleid.apple.com'
    end
    return [200, jwks_json(:attacker)] if host == ATTACKER_HOST
    [404, '{}']
  end

  def fake_response(status, body)
    klass = Net::HTTPResponse::CODE_TO_OBJ.fetch(status.to_s)
    res = klass.new('1.1', status.to_s, 'qa')
    res['Content-Type'] = 'application/json'
    res['Cache-Control'] = 'public, max-age=21600'
    res.instance_variable_set(:@qa_body, body)
    res.instance_variable_set(:@read, true)
    res.instance_variable_set(:@body, body)
    res.define_singleton_method(:body) { @qa_body }
    res.define_singleton_method(:read_body) do |_dest = nil, &blk|
      blk&.call(@qa_body)
      @qa_body
    end
    res
  end

  module NetHttpStub
    def connect
      return super unless QaOauth.active
    end

    def do_finish
      return super unless QaOauth.active
      @started = false
    end

    def request(req, body = nil, &block)
      return super unless QaOauth.active
      path = req.path.split('?').first
      QaOauth.requests << { host: address, path: path, url: "#{use_ssl? ? 'https' : 'http'}://#{address}#{req.path}",
                            open_timeout: open_timeout, read_timeout: read_timeout }
      res = QaOauth.fake_response(*QaOauth.respond_to_url(address, path))
      block&.call(res)
      res
    end
  end
  Net::HTTP.prepend(NetHttpStub)
end

module QaOauthHelpers
  def qa_b64(bytes) = QaOauth.b64(bytes)
  def now_i = Time.now.to_i

  # Compact JWS. alg 'none' -> empty signature; 'HS256' signs with `key` as
  # the HMAC secret (string); RSxxx signs with the RSA `key`.
  def build_jwt(header, payload, key:, alg: header[:alg] || header['alg'])
    input = "#{qa_b64(JSON.generate(header))}.#{qa_b64(JSON.generate(payload))}"
    sig = case alg
          when 'none' then ''
          when 'HS256' then OpenSSL::HMAC.digest('SHA256', key, input)
          when 'RS256' then key.sign(OpenSSL::Digest.new('SHA256'), input)
          when 'RS384' then key.sign(OpenSSL::Digest.new('SHA384'), input)
          when 'RS512' then key.sign(OpenSSL::Digest.new('SHA512'), input)
          else raise "qa: unknown alg #{alg}"
          end
    "#{input}.#{qa_b64(sig)}"
  end

  def google_claims(nonce:, email:, sub: "g-#{SecureRandom.hex(6)}", email_verified: true, **over)
    { iss: 'https://accounts.google.com', azp: QaOauth::GOOGLE_WEB, aud: QaOauth::GOOGLE_WEB, sub: sub,
      email: email, email_verified: email_verified, hd: email.to_s.split('@').last&.strip&.downcase, # Workspace account: Google is authoritative
      nonce: nonce, iat: now_i, exp: now_i + 3600 }.merge(over)
  end

  def apple_claims(raw_nonce:, email:, sub: "001234.#{SecureRandom.hex(8)}.0001", email_verified: 'true', **over)
    { iss: 'https://appleid.apple.com', aud: QaOauth::APPLE_BUNDLE, sub: sub, email: email,
      email_verified: email_verified, nonce: Digest::SHA256.hexdigest(raw_nonce), nonce_supported: true,
      iat: now_i, exp: now_i + 600 }.merge(over)
  end

  def signed(provider, claims, header: {})
    h = { alg: 'RS256', kid: QaOauth::KIDS.fetch(provider), typ: 'JWT' }.merge(header)
    build_jwt(h, claims, key: QaOauth::KEYS.fetch(provider), alg: h[:alg])
  end

  def google_token(nonce:, email:, header: {}, **over) = signed(:google, google_claims(nonce: nonce, email: email, **over), header: header)
  def apple_token(raw_nonce:, email:, header: {}, **over) = signed(:apple, apple_claims(raw_nonce: raw_nonce, email: email, **over), header: header)

  def oauth_start
    post '/api/v1/auth/oauth/start', params: {}, as: :json
    expect(response).to have_http_status(:ok)
    body = JSON.parse(response.body)
    expect(body).to include('ticket', 'nonce', 'expires_at')
    body
  end

  def oauth_session(provider, ticket:, id_token:, device:, **extra)
    post "/api/v1/auth/oauth/#{provider}/session",
         params: { ticket: ticket, id_token: id_token, device: device }.merge(extra).compact, as: :json
  end

  # Full happy-path sign-in; returns [body, device_key].
  def oauth_sign_in(provider, email:, key: new_device_key, **claims)
    start = oauth_start
    token = provider == :google ? google_token(nonce: start['nonce'], email: email, **claims) : apple_token(raw_nonce: start['nonce'], email: email, **claims)
    oauth_session(provider, ticket: start['ticket'], id_token: token, device: enroll_proof(key, start['nonce']))
    [response, (JSON.parse(response.body) rescue {})]
  end

  def expect_generic_401(error = 'verification_failed')
    expect(response).to have_http_status(:unauthorized)
    expect(JSON.parse(response.body)).to eq('error' => error)
  end
end

RSpec.configure do |c|
  c.include QaOauthHelpers, qa_oauth: true
  c.include ActiveSupport::Testing::TimeHelpers, qa_oauth: true
  c.around(:each, qa_oauth: true) do |example|
    saved = QaOauth::ENV_VARS.keys.to_h { |k| [k, ENV[k]] }
    QaOauth::ENV_VARS.each { |k, v| ENV[k] = v }
    QaOauth.reset!
    QaOauth.active = true
    # Builder's in-process JWKS cache (Authentication::IdToken); other specs may have cached their own keys.
    Authentication::IdToken.reset_jwks_cache! if defined?(Authentication::IdToken) && Authentication::IdToken.respond_to?(:reset_jwks_cache!)
    example.run
  ensure
    QaOauth.active = false
    saved.each { |k, v| v.nil? ? ENV.delete(k) : ENV[k] = v }
  end
end
