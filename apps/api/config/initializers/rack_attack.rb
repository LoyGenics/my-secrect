# Rate limits for the abuse-sensitive endpoints. Auth + recovery are the
# most brute-forceable; sync/items are token-authenticated and cheaper.
#
# Store (closes M2): production counts in Redis (REDIS_URL), shared by
# every Puma worker and surviving restarts; booting production without
# REDIS_URL RAISES (fail closed — per-process memory counters would let an
# attacker multiply every limit by the worker count). Other environments
# use an in-process MemoryStore. If Redis becomes unreachable at runtime,
# Rack::Attack counts nothing (the requests are served) and the error
# class — never a key or value — is logged; that is a deliberate
# availability trade-off for an outage, not a configuration path.
#
# Test: throttles are OFF by default because request specs drive many
# auth calls from one IP; spec/requests/api/v1/rate_limiting_spec.rb turns
# them on and proves every throttle below fires. The browser e2e harness
# runs in the test env, so it does not exercise throttling.
module RackAttackStore
  class ConfigurationError < StandardError; end

  module_function

  def build(rails_env:, env:)
    return ActiveSupport::Cache::MemoryStore.new unless rails_env.to_s == 'production'

    url = env['REDIS_URL'].presence
    raise ConfigurationError, 'production requires REDIS_URL for rate limiting (Rack::Attack)' unless url

    ActiveSupport::Cache::RedisCacheStore.new(
      url: url, namespace: 'rack-attack',
      error_handler: ->(method:, returning:, exception:) { Rails.logger.warn("rack-attack store #{method} failed: #{exception.class}") }
    )
  end
end

class Rack::Attack
  self.enabled = false if Rails.env.test?
  cache.store = RackAttackStore.build(rails_env: Rails.env, env: ENV)

  # Normalised account email from the JSON (or form) body, for per-address
  # limits that an attacker cannot dodge by rotating IPs. nil when absent
  # or unparsable (the per-IP limits still apply).
  def self.account_email(req)
    params = ActionDispatch::Request.new(req.env).request_parameters
    params['email'].to_s.strip.downcase.presence
  rescue StandardError
    nil
  end

  EMAIL_REQUEST = '/api/v1/auth/email/request'.freeze
  EMAIL_VERIFY = '/api/v1/auth/email/verify'.freeze
  EMAIL_SESSION = '/api/v1/auth/email/session'.freeze
  STEP_UP_EMAIL_REQUEST = '/api/v1/auth/step-up/email/request'.freeze
  STEP_UP_EMAIL = '/api/v1/auth/step-up/email'.freeze
  PASSKEY_EMAIL_PATHS = %w[/api/v1/auth/passkeys/register /api/v1/auth/passkeys/authenticate
                           /api/v1/auth/passkeys/verify].freeze

  # Sign-up email codes. Per address: at most 3 codes per 10 minutes (each
  # new code supersedes the previous one, so this also bounds guessing to
  # 3 x 5 attempts per 10 minutes) and no mail-bombing one inbox from many
  # IPs. Per IP: limits sweeping many addresses.
  throttle('auth/email/request/ip', limit: 5, period: 60) { |req| req.ip if req.post? && req.path == EMAIL_REQUEST }
  throttle('auth/email/request/email', limit: 3, period: 600) { |req| account_email(req) if req.post? && req.path == EMAIL_REQUEST }
  throttle('auth/email/verify/ip', limit: 10, period: 60) { |req| req.ip if req.post? && req.path == EMAIL_VERIFY }
  throttle('auth/email/verify/email', limit: 10, period: 600) { |req| account_email(req) if req.post? && req.path == EMAIL_VERIFY }

  # Email sign-in (ticket -> session) and the email step-up of a signed-in
  # account. The step-up request is also capped per session token, like the
  # per-address cap above, so one session cannot mail-bomb or out-guess it.
  throttle('auth/email/session/ip', limit: 10, period: 60) { |req| req.ip if req.post? && req.path == EMAIL_SESSION }
  throttle('auth/step-up/email/ip', limit: 10, period: 60) do |req|
    req.ip if req.post? && [STEP_UP_EMAIL_REQUEST, STEP_UP_EMAIL].include?(req.path)
  end
  throttle('auth/step-up/email/request/session', limit: 3, period: 600) do |req|
    req.get_header('HTTP_AUTHORIZATION').presence if req.post? && req.path == STEP_UP_EMAIL_REQUEST
  end

  # Passkey options + verify (sign-up, sign-in, add). Per IP for every
  # passkey route, plus per account email for the unauthenticated ones.
  throttle('passkey/verify', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/passkeys') }
  throttle('passkey/add', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/passkeys/add') }
  throttle('passkey/email', limit: 10, period: 60) { |req| account_email(req) if req.post? && PASSKEY_EMAIL_PATHS.include?(req.path) }

  throttle('mfa/verify', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/auth/mfa/verify' }
  throttle('recovery/challenges', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/recovery/challenges' }
  throttle('recovery/verify', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/recovery/verify' }
  throttle('recovery/verify/email', limit: 5, period: 300) { |req| account_email(req) if req.post? && req.path == '/api/v1/recovery/verify' }
  throttle('step-up', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/step-up') }
  # Device proof endpoints (challenge issue, bind, enrol).
  throttle('devices/proof', limit: 10, period: 60) do |req|
    req.ip if req.post? && (req.path == '/api/v1/devices/challenges' || req.path == '/api/v1/devices/enroll' ||
                            req.path.match?(%r{\A/api/v1/devices/[^/]+/bind\z}))
  end
  throttle('api/ip', limit: 300, period: 60) { |req| req.ip if req.path.start_with?('/api/') }

  self.throttled_responder = ->(_req) { [429, { 'Content-Type' => 'application/json' }, [{ error: 'rate_limited' }.to_json]] }
end

class Rack::Attack
  throttle('imports/preview/ip', limit: 6, period: 60) do |req|
    req.ip if req.post? && req.path == '/api/v1/imports/preview'
  end
  throttle('billing/customer/ip', limit: 30, period: 60) do |req|
    req.ip if req.path.start_with?('/api/v1/billing') && !req.path.start_with?('/api/v1/billing/webhooks/')
  end
  throttle('share-links/read/ip', limit: 120, period: 60) { |req| req.ip if req.get? && req.path.start_with?('/api/v1/share-links/') }
  throttle('share-links/create/ip', limit: 20, period: 60) { |req| req.ip if req.post? && req.path == '/api/v1/share-links' }
end
