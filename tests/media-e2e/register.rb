# Registers a throwaway user through the REAL sign-up endpoints (email code
# from the test mail catcher, then passkey registration: webauthn gem
# FakeClient = software authenticator, verified by the server, plus an
# Ed25519 device proof — infra/docker/smoke/signup.rb) and
# creates a vault. Prints one JSON line {"token":..,"vault_id":..} to stdout
# for the test runner (never echoed by run.sh). Run from apps/api:
#   SMOKE_ORIGIN=https://localhost:PORT MAILPIT_URL=http://127.0.0.1:PORT \
#     bundle exec ruby ../../tests/media-e2e/register.rb
require 'net/http'
require 'json'
require 'securerandom'
require 'base64'
require 'openssl'
require 'forwardable'
require 'webauthn'
require 'webauthn/fake_client'
require_relative '../../infra/docker/smoke/signup'

ORIGIN = ENV.fetch('SMOKE_ORIGIN')
HOST = URI(ORIGIN).host
PORT = URI(ORIGIN).port

def api(method, path, body: nil, token: nil)
  http = Net::HTTP.new(HOST, PORT)
  http.ipaddr = '127.0.0.1'
  http.use_ssl = true
  http.verify_mode = OpenSSL::SSL::VERIFY_NONE # Caddy internal CA, local throwaway stack only
  req = { get: Net::HTTP::Get, post: Net::HTTP::Post }.fetch(method).new("/api/v1#{path}")
  req['Content-Type'] = 'application/json'
  req['Authorization'] = "Bearer #{token}" if token
  req.body = JSON.generate(body) if body
  attempts = 0
  begin
    res = http.request(req)
  rescue Errno::ECONNRESET, OpenSSL::SSL::SSLError
    # Caddy may still be minting its internal-CA cert right after it turns healthy.
    attempts += 1
    raise if attempts > 10
    sleep 2
    retry
  end
  [res.code.to_i, res.body.to_s.empty? ? nil : JSON.parse(res.body)]
end

email = "media-e2e-#{SecureRandom.hex(6)}@example.test"
client = WebAuthn::FakeClient.new(ORIGIN)
# Email code (read from the test mail catcher, MAILPIT_URL) -> ticket ->
# passkey registration with a device proof, so the session is bound to an
# active device (vaults/sync/items answer 403 otherwise).
begin
  reg, = TestSignup.sign_up(method(:api), client, email, TestSignup::DeviceKey.new)
rescue StandardError => e
  abort("sign-up: #{e.message}")
end
token = reg['token'] or abort('no token')
code, vault = api(:post, '/vaults', token: token, body: { encrypted_metadata: Base64.strict_encode64(SecureRandom.random_bytes(48)) })
abort("vault create: HTTP #{code}") unless code == 201
puts JSON.generate(token: token, vault_id: vault.dig('vault', 'id'))
