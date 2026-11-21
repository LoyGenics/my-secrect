require 'digest'
require 'json'
require 'jwt'
require 'openssl'

# The PROVIDER side of Sign in with Google / Apple for specs: RSA keys
# generated here, published as a JWKS through a stub of
# Authentication::IdToken.fetch_jwks (nothing ever reaches Google or
# Apple), and ID tokens signed with them.
module OauthHelper
  GOOGLE_WEB = 'web.apps.googleusercontent.test'.freeze
  GOOGLE_IOS = 'ios.apps.googleusercontent.test'.freeze
  GOOGLE_ANDROID = 'android.apps.googleusercontent.test'.freeze
  GOOGLE_EXTENSION = 'extension.apps.googleusercontent.test'.freeze
  APPLE_SERVICES = 'test.my-secrect.web'.freeze
  APPLE_BUNDLE = 'test.my-secrect.app'.freeze
  OAUTH_ENV = {
    'GOOGLE_WEB_CLIENT_ID' => GOOGLE_WEB, 'GOOGLE_IOS_CLIENT_ID' => GOOGLE_IOS,
    'GOOGLE_ANDROID_CLIENT_ID' => GOOGLE_ANDROID, 'GOOGLE_EXTENSION_CLIENT_ID' => GOOGLE_EXTENSION,
    'APPLE_SERVICES_ID' => APPLE_SERVICES, 'APPLE_BUNDLE_ID' => APPLE_BUNDLE
  }.freeze
  ISSUERS = { 'google' => 'https://accounts.google.com', 'apple' => 'https://appleid.apple.com' }.freeze
  AUDIENCES = { 'google' => GOOGLE_WEB, 'apple' => APPLE_BUNDLE }.freeze
  JWKS_URIS = { 'google' => 'https://www.googleapis.com/oauth2/v3/certs',
                'apple' => 'https://appleid.apple.com/auth/keys' }.freeze

  # One key per name for the whole run (RSA generation is slow).
  def self.rsa_key(name)
    @keys ||= {}
    @keys[name] ||= OpenSSL::PKey::RSA.generate(2048)
  end

  def provider_key(name = 'main') = OauthHelper.rsa_key(name)

  def jwks_for(*keys_with_kids)
    { 'keys' => keys_with_kids.map { |key, kid| JWT::JWK.new(key.public_key, { kid: kid, alg: 'RS256', use: 'sig' }).export } }
      .then { |set| JSON.parse(set.to_json) }
  end

  # Both providers publish [provider_key, 'kid-main'] unless told otherwise.
  # `fetches` counts calls per provider.
  def stub_provider_jwks(google: nil, apple: nil)
    sets = { 'google' => google, 'apple' => apple }.transform_values { |set| set || jwks_for([provider_key, 'kid-main']) }
    @jwks_fetches = Hash.new(0)
    allow(Authentication::IdToken).to receive(:fetch_jwks) do |uri|
      provider = JWKS_URIS.key(uri) or raise "unexpected JWKS fetch: #{uri}"
      @jwks_fetches[provider] += 1
      sets.fetch(provider)
    end
  end

  def jwks_fetches = @jwks_fetches

  # The nonce claim as each provider carries it.
  def provider_nonce(provider, nonce) = provider == 'apple' ? Digest::SHA256.hexdigest(nonce) : nonce

  def id_token_for(provider, nonce:, sub: 'subject-1', email: 'person@example.test', key: provider_key, kid: 'kid-main',
                   alg: 'RS256', **claims)
    now = Time.now.to_i
    payload = { iss: ISSUERS.fetch(provider), aud: AUDIENCES.fetch(provider), sub: sub, email: email,
                email_verified: provider == 'apple' ? 'true' : true, iat: now, exp: now + 600,
                nonce: provider_nonce(provider, nonce) }.merge(claims).compact
    JWT.encode(payload, key, alg, { kid: kid })
  end

  def with_env(vars)
    previous = vars.keys.index_with { |name| ENV[name] }
    vars.each { |name, value| ENV[name] = value }
    yield
  ensure
    previous.each { |name, value| ENV[name] = value }
  end
end

RSpec.configure do |c|
  c.include OauthHelper
  c.before { Authentication::IdToken.reset_jwks_cache! }
end
