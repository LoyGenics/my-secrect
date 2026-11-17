# Black-box API flow run INSIDE the api container (needs webauthn's FakeClient
# + aws-sdk-s3, both in the production bundle). It talks HTTPS to the real
# Caddy -> api path (not the Rails process directly) and to the real MinIO.
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
require 'resolv'
require 'forwardable'
require 'webauthn'
require 'webauthn/fake_client'
require 'aws-sdk-s3'

ORIGIN = ENV.fetch('SMOKE_ORIGIN')               # e.g. https://localhost:8443 (== WEBAUTHN_ORIGIN)
HOST = URI(ORIGIN).host
CADDY_IP = Resolv.getaddress(ENV.fetch('SMOKE_CADDY_HOST', 'caddy'))
BYTES = Integer(ENV.fetch('SMOKE_BYTES', 1_048_576))

def step(msg) = puts("[flow] #{msg}")
def fail!(msg)
  warn "[flow] FAIL: #{msg}"
  exit 1
end

def api(method, path, body: nil, token: nil)
  http = Net::HTTP.new(HOST, 443)
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

s3 = Aws::S3::Client.new(
  endpoint: ENV.fetch('S3_ENDPOINT'), region: ENV.fetch('S3_REGION'),
  access_key_id: ENV.fetch('S3_ACCESS_KEY'), secret_access_key: ENV.fetch('S3_SECRET_KEY'),
  force_path_style: true
)
bucket = ENV.fetch('S3_BUCKET')

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

# --- blob round trip against real MinIO
payload = SecureRandom.random_bytes(BYTES)
blob_id = SecureRandom.uuid
code, up = api(:post, '/blobs/upload-session', token: token, body: {
  vault_id: vault_id, blob_id: blob_id, part_count: 1, ciphertext_size: payload.bytesize,
  encrypted_manifest: Base64.strict_encode64(SecureRandom.random_bytes(64))
})
expect_status!('upload-session', code, 201)
part = up['parts'].first
object_key = part['object_key']
put = URI(part['url'])
res = Net::HTTP.start(put.host, put.port, use_ssl: put.scheme == 'https') do |h|
  r = Net::HTTP::Put.new(put.request_uri)
  r.body = payload
  h.request(r)
end
fail!("presigned PUT failed: HTTP #{res.code}") unless res.code.to_i == 200
step 'presigned PUT: HTTP 200'

code, = api(:post, "/blobs/#{blob_id}/complete", token: token, body: {
  parts: [{ part_number: 1, ciphertext_size: payload.bytesize,
            ciphertext_sha256_b64: Base64.strict_encode64(Digest::SHA256.digest(payload)) }]
})
expect_status!('complete', code, 200)

code, dl = api(:get, "/blobs/#{blob_id}/download-session", token: token)
expect_status!('download-session', code, 200)
get = URI(dl['parts'].first['url'])
res = Net::HTTP.start(get.host, get.port, use_ssl: get.scheme == 'https') { |h| h.request(Net::HTTP::Get.new(get.request_uri)) }
fail!("presigned GET failed: HTTP #{res.code}") unless res.code.to_i == 200
fail!('byte equality FAILED') unless Digest::SHA256.hexdigest(res.body) == Digest::SHA256.hexdigest(payload) && res.body.bytesize == payload.bytesize
step "byte round trip OK (#{payload.bytesize} bytes, sha256 #{Digest::SHA256.hexdigest(payload)[0, 16]}...)"

s3.head_object(bucket: bucket, key: object_key)
step 'MinIO HEAD before deletion: object present'

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

begin
  s3.head_object(bucket: bucket, key: object_key)
  fail!('object still present in MinIO after account deletion')
rescue Aws::S3::Errors::NotFound
  step 'MinIO HEAD after deletion: 404 (object gone)'
end
puts "FLOW_OK key_prefix=vaults/#{vault_id}/"
