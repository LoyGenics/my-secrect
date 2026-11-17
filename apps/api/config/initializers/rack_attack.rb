# Rate limits for the abuse-sensitive endpoints. Auth + recovery are the
# most brute-forceable; sync/items are token-authenticated and cheaper.
# Requires Redis (Rack::Attack.cache.store = Redis in production).
class Rack::Attack
  throttle('passkey/verify', limit: 10, period: 60) { |req| req.ip if req.path.start_with?('/api/v1/auth/passkeys') }
  throttle('recovery/challenges', limit: 5, period: 60) { |req| req.ip if req.path == '/api/v1/recovery/challenges' }
  throttle('api/ip', limit: 300, period: 60) { |req| req.ip if req.path.start_with?('/api/') }
  self.throttled_responder = ->(_env) { [429, { 'Content-Type' => 'application/json' }, [{ error: 'rate_limited' }.to_json]] }
end
