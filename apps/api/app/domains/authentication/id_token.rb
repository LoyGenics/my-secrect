require 'digest'
require 'json'
require 'jwt'
require 'net/http'
require 'openssl'

module Authentication
  # Verifies a Google or Apple OpenID Connect ID token
  # (specs/account-sign-in.md §3). Returns the verified { subject:, email: }
  # or raises one generic VerificationError.
  #
  # Rules (never weaken):
  #   * RS256 only, signed by a key from the provider's own JWKS (fetched
  #     over HTTPS, cached JWKS_TTL, refetched once when a token names an
  #     unknown kid, at most every JWKS_MIN_REFRESH). No "none", no HMAC,
  #     no key from the token itself.
  #   * iss is the provider's issuer; aud is one of this deployment's
  #     client ids (OauthProviders); exp and iat checked with LEEWAY.
  #   * nonce is the ticket's nonce: Google carries it raw, Apple carries
  #     SHA-256 hex of it.
  #   * email present and email_verified true (Apple sends "true").
  #   * Nothing from the token is logged.
  module IdToken
    class VerificationError < StandardError; end

    PROVIDERS = {
      'google' => { jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
                    issuers: %w[accounts.google.com https://accounts.google.com] },
      'apple' => { jwks_uri: 'https://appleid.apple.com/auth/keys', issuers: %w[https://appleid.apple.com] }
    }.freeze
    LEEWAY = 60
    JWKS_TTL = 1.hour
    JWKS_MIN_REFRESH = 1.minute
    FETCH_ERRORS = [SocketError, SystemCallError, IOError, Timeout::Error, Net::OpenTimeout, Net::ReadTimeout,
                    OpenSSL::SSL::SSLError, JSON::ParserError].freeze

    @jwks_cache = {}
    @jwks_lock = Mutex.new

    module_function

    def verify!(provider:, id_token:, nonce:)
      config = PROVIDERS[provider]
      audiences = config ? OauthProviders.audiences(provider) : []
      fail! if audiences.empty? || !id_token.is_a?(String)

      claims, = JWT.decode(
        id_token, nil, true,
        algorithms: ['RS256'], jwks: ->(options) { jwks(provider, refresh: options[:kid_not_found]) },
        iss: config[:issuers], verify_iss: true, aud: audiences, verify_aud: true,
        verify_expiration: true, leeway: LEEWAY, verify_iat: { leeway: LEEWAY },
        required_claims: %w[iss aud sub exp iat nonce]
      )
      expected_nonce = provider == 'apple' ? Digest::SHA256.hexdigest(nonce) : nonce
      fail! unless ActiveSupport::SecurityUtils.secure_compare(claims['nonce'].to_s, expected_nonce)
      email = claims['email'].to_s.strip.downcase
      fail! unless claims['sub'].present? && email.present? && [true, 'true'].include?(claims['email_verified'])
      { subject: claims['sub'].to_s, email: email }
    rescue JWT::DecodeError
      fail!
    end

    # The provider's JWKS ({ "keys" => [...] }), from the in-process cache.
    def jwks(provider, refresh: false)
      @jwks_lock.synchronize do
        entry = @jwks_cache[provider]
        stale = entry.nil? || entry[:fetched_at] < JWKS_TTL.ago ||
                (refresh && entry[:fetched_at] < JWKS_MIN_REFRESH.ago)
        @jwks_cache[provider] = { keys: fetch_jwks(PROVIDERS.fetch(provider)[:jwks_uri]), fetched_at: Time.current } if stale
        @jwks_cache[provider][:keys]
      end
    end

    def fetch_jwks(uri)
      uri = URI(uri)
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 5) do |http|
        http.get(uri.request_uri)
      end
      fail! unless response.is_a?(Net::HTTPSuccess)
      JSON.parse(response.body)
    rescue *FETCH_ERRORS => e
      Rails.logger.warn("id token JWKS fetch failed: #{e.class}")
      fail!
    end

    # Specs only: forget cached keys.
    def reset_jwks_cache!
      @jwks_lock.synchronize { @jwks_cache.clear }
    end

    def fail!
      raise VerificationError, 'verification failed'
    end
  end
end
