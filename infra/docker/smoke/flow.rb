# Black-box API flow run on the HOST (outside the compose network) via
# `bundle exec ruby` in apps/api (needs the webauthn gem's FakeClient). It
# reaches the stack ONLY through the published Caddy port on 127.0.0.1:
#   - API  : https://<SITE>:<port>/api/v1  (Host = localhost)
#   - S3   : the PUBLIC presigned URLs the API returns (Host = s3.localhost),
#            so the SigV4 host-signing + Caddy host routing + MinIO CORS are
#            exercised for real. Nothing here can resolve minio:9000.
#
# Exercises, for real: WebAuthn registration (software authenticator =
# webauthn gem FakeClient: real ES256 keys, real attestation/assertion,
# verified by the server), vault create, blob upload-session -> presigned
# PUT of RANDOM bytes (stand-in for ciphertext; no crypto is claimed) ->
# complete -> download-session -> presigned GET -> byte equality, passkey
# step-up, DELETE account, then HEAD against MinIO proves the object is gone.
# Never prints tokens, keys or credentials.
require 'net/http'
require 'json'
require 'securerandom'
require 'base64'
require 'digest'
require 'openssl'
require 'forwardable'
require 'webauthn'
require 'webauthn/fake_client'

ORIGIN = ENV.fetch('SMOKE_ORIGIN')               # e.g. https://localhost:18443 (== WEBAUTHN_ORIGIN)
HOST = URI(ORIGIN).host
PORT = URI(ORIGIN).port
CADDY_IP = ENV.fetch('SMOKE_CADDY_IP', '127.0.0.1') # published Caddy port on this host
PART_BYTES = Integer(ENV.fetch('SMOKE_PART_BYTES', 1_048_576))
PARTS = Integer(ENV.fetch('SMOKE_PARTS', 3))

def step(msg) = puts("[flow] #{msg}")
def fail!(msg)
  warn "[flow] FAIL: #{msg}"
  exit 1
end

def api(method, path, body: nil, token: nil)
  http = Net::HTTP.new(HOST, PORT)
  http.ipaddr = CADDY_IP
  http.use_ssl = true
  http.verify_mode = OpenSSL::SSL::VERIFY_NONE # Caddy internal CA, local smoke only
  klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, delete: Net::HTTP::Delete }.fetch(method)
  req = klass.new("/api/v1#{path}")
  req['Content-Type'] = 'application/json'
  req['Authorization'] = "Bearer #{token}" if token
  req.body = JSON.generate(body) if body
  res = http.request(req)
  parsed = res.body.to_s.empty? ? nil : JSON.parse(res.body)
  [res.code.to_i, parsed]
end

def expect_status!(label, got, want)
  fail!("#{label}: expected HTTP #{want}, got #{got}") unless got == want
  step "#{label}: HTTP #{got}"
end

# One request to a presigned (public S3) URL, from outside the compose
# network: TCP goes to the published Caddy port, TLS SNI / Host stay the
# URL's host (s3.localhost), exactly like a real client.
def s3_request(klass, url, body: nil, headers: {})
  u = URI(url)
  http = Net::HTTP.new(u.host, u.port)
  http.ipaddr = CADDY_IP
  http.use_ssl = u.scheme == 'https'
  http.verify_mode = OpenSSL::SSL::VERIFY_NONE # Caddy internal CA, local smoke only
  req = klass.new(u.request_uri)
  headers.each { |k, v| req[k] = v }
  req.body = body if body
  http.request(req)
end

def assert_public_url!(label, url)
  u = URI(url)
  fail!("#{label}: presigned URL host is #{u.host}, expected s3.#{HOST}") unless u.host == "s3.#{HOST}"
  fail!("#{label}: presigned URL port is #{u.port}, expected #{PORT}") unless u.port == PORT
  fail!("#{label}: presigned URL leaks the internal minio host") if url.include?('minio')
  step "#{label}: presigned URL is public (#{u.host}:#{u.port})"
end

# --- registration (real WebAuthn ceremony)
email = "smoke-#{SecureRandom.hex(6)}@example.test"
client = WebAuthn::FakeClient.new(ORIGIN)
code, opts = api(:post, '/auth/passkeys/register', body: { email: email })
expect_status!('passkey register options', code, 200)
credential = client.create(challenge: opts['creation_options']['challenge'], user_verified: true)
code, reg = api(:post, '/auth/passkeys/verify', body: { email: email, credential: credential, kind: 'registration' })
expect_status!('passkey register verify', code, 200)
token = reg['token'] or fail!('no session token')

# --- vault
code, vault = api(:post, '/vaults', token: token, body: { encrypted_metadata: Base64.strict_encode64(SecureRandom.random_bytes(48)) })
expect_status!('vault create', code, 201)
vault_id = vault.dig('vault', 'id')

# --- blob round trip against real MinIO, through the PUBLIC endpoint
parts_data = Array.new(PARTS) { SecureRandom.random_bytes(PART_BYTES) }
total = parts_data.sum(&:bytesize)
blob_id = SecureRandom.uuid
code, up = api(:post, '/blobs/upload-session', token: token, body: {
  vault_id: vault_id, blob_id: blob_id, part_count: PARTS, ciphertext_size: total,
  encrypted_manifest: Base64.strict_encode64(SecureRandom.random_bytes(64))
})
expect_status!('upload-session', code, 201)
fail!("expected #{PARTS} presigned parts") unless up['parts'].size == PARTS
assert_public_url!('upload-session', up['parts'].first['url'])

# CORS preflight as a browser would send it (Origin = the app origin).
pre = s3_request(Net::HTTP::Options, up['parts'].first['url'], headers: {
  'Origin' => ORIGIN, 'Access-Control-Request-Method' => 'PUT', 'Access-Control-Request-Headers' => 'content-type'
})
fail!("CORS preflight failed: HTTP #{pre.code}") unless pre.code.to_i.between?(200, 204)
fail!("CORS preflight: allow-origin is #{pre['access-control-allow-origin'].inspect}") unless pre['access-control-allow-origin'] == ORIGIN
fail!('CORS preflight: PUT not allowed') unless pre['access-control-allow-methods'].to_s.upcase.include?('PUT')
step 'CORS preflight OK (allow-origin == app origin, PUT allowed)'
evil = s3_request(Net::HTTP::Options, up['parts'].first['url'], headers: {
  'Origin' => 'https://evil.example', 'Access-Control-Request-Method' => 'PUT'
})
fail!('CORS: foreign origin was allowed') if evil['access-control-allow-origin'] && evil['access-control-allow-origin'] != ORIGIN
step 'CORS: foreign origin not allowed'

up['parts'].each_with_index do |part, i|
  res = s3_request(Net::HTTP::Put, part['url'], body: parts_data[i], headers: { 'Origin' => ORIGIN, 'Content-Type' => 'application/octet-stream' })
  fail!("presigned PUT part #{i + 1} failed: HTTP #{res.code}") unless res.code.to_i == 200
  if i.zero?
    fail!("PUT response lacks ETag") if res['etag'].to_s.empty?
    exposed = res['access-control-expose-headers'].to_s.downcase
    fail!("PUT response does not expose ETag to browsers (expose-headers=#{exposed.inspect})") unless exposed.include?('etag') || exposed == '*'
    step 'presigned PUT: HTTP 200, ETag present and exposed via CORS'
  end
end

code, = api(:post, "/blobs/#{blob_id}/complete", token: token, body: {
  parts: parts_data.each_with_index.map { |d, i| { part_number: i + 1, ciphertext_size: d.bytesize, ciphertext_sha256_b64: Base64.strict_encode64(Digest::SHA256.digest(d)) } }
})
expect_status!('complete', code, 200)

code, dl = api(:get, "/blobs/#{blob_id}/download-session", token: token)
expect_status!('download-session', code, 200)
assert_public_url!('download-session', dl['parts'].first['url'])
dl['parts'].each_with_index do |part, i|
  res = s3_request(Net::HTTP::Get, part['url'], headers: { 'Origin' => ORIGIN })
  fail!("presigned GET part #{i + 1} failed: HTTP #{res.code}") unless res.code.to_i == 200
  fail!("byte equality FAILED for part #{i + 1}") unless res.body.bytesize == parts_data[i].bytesize && Digest::SHA256.digest(res.body) == Digest::SHA256.digest(parts_data[i])
  fail!('GET response lacks CORS allow-origin') unless res['access-control-allow-origin'] == ORIGIN
end
step "byte round trip OK via public endpoint (#{PARTS} parts, #{total} bytes)"
get_url = dl['parts'].first['url'] # re-used after account deletion: must 404

# A tampered signature must be refused by MinIO (the presigned URL is really checked).
bad = URI(get_url)
bad.query = bad.query.sub(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=00000000')
res = s3_request(Net::HTTP::Get, bad.to_s)
fail!("forged presigned signature was accepted: HTTP #{res.code}") if res.code.to_i == 200
step "forged presigned signature refused: HTTP #{res.code}"

# --- step-up (passkey) + account deletion
code, so = api(:post, '/auth/step-up/passkey/options', token: token)
expect_status!('step-up options', code, 200)
assertion = client.get(challenge: so['request_options']['challenge'], user_verified: true, allow_credentials: [credential['id']])
code, = api(:post, '/auth/step-up/passkey', token: token, body: { credential: assertion })
expect_status!('step-up passkey', code, 200)
code, = api(:delete, '/auth/account', token: token)
expect_status!('DELETE account', code, 204)

code, = api(:get, '/vaults', token: token)
expect_status!('old token after deletion', code, 401)

res = s3_request(Net::HTTP::Get, get_url)
fail!("object still readable via public endpoint after account deletion: HTTP #{res.code}") unless res.code.to_i == 404
step 'public GET after deletion: 404 (object gone)'
puts "FLOW_OK vault=#{vault_id}"
