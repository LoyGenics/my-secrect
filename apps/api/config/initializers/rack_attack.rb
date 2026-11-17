# Rate limits for the abuse-sensitive endpoints. Auth + recovery are the
# most brute-forceable; sync/items are token-authenticated and cheaper.
# Requires Redis (Rack::Attack.cache.store = Redis in production).
# NOTE (M2, still open): the cache store is never configured — throttles
# are per-process, in-memory, reset on restart, no cross-worker sharing.
class Rack::Attack
  # Disabled in test: request specs drive many auth calls from one IP and
  # would trip the per-IP throttles (throttling itself is not spec-covered).
  self.enabled = false if Rails.env.test?
  throttle('passkey/verify', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/passkeys') }
  throttle('passkey/add', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/passkeys/add') }
  throttle('mfa/verify', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/auth/mfa/verify' }
  throttle('recovery/challenges', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/recovery/challenges' }
  throttle('recovery/verify', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/recovery/verify' }
  throttle('step-up', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/step-up') }
  throttle('api/ip', limit: 300, period: 60) { |req| req.ip if req.path.start_with?('/api/') }
  self.throttled_responder = ->(_env) { [429, { 'Content-Type' => 'application/json' }, [{ error: 'rate_limited' }.to_json]] }
end
