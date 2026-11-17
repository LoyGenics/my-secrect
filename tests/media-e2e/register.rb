# Registers a throwaway user through the REAL passkey endpoints (webauthn
# gem FakeClient = software authenticator, verified by the server) and
# creates a vault. Prints one JSON line {"token":..,"vault_id":..} to stdout
# for the test runner (never echoed by run.sh). Run from apps/api:
#   SMOKE_ORIGIN=https://localhost:PORT bundle exec ruby ../../tests/media-e2e/register.rb
require 'net/http'
require 'json'
require 'securerandom'
require 'base64'
require 'openssl'
require 'forwardable'
require 'webauthn'
require 'webauthn/fake_client'

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
code, opts = api(:post, '/auth/passkeys/register', body: { email: email })
abort("register options: HTTP #{code}") unless code == 200
credential = client.create(challenge: opts['creation_options']['challenge'], user_verified: true)
code, reg = api(:post, '/auth/passkeys/verify', body: { email: email, credential: credential, kind: 'registration' })
abort("register verify: HTTP #{code}") unless code == 200
token = reg['token'] or abort('no token')
code, vault = api(:post, '/vaults', token: token, body: { encrypted_metadata: Base64.strict_encode64(SecureRandom.random_bytes(48)) })
abort("vault create: HTTP #{code}") unless code == 201
puts JSON.generate(token: token, vault_id: vault.dig('vault', 'id'))
