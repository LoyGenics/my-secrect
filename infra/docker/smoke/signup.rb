# Test-only sign-up helpers shared by infra/docker/smoke/flow.rb and
# tests/media-e2e/register.rb (both run on the HOST via `bundle exec ruby`
# in apps/api):
#   * the email-ownership step: POST /auth/email/request, read the 6-digit
#     code from Mailpit's HTTP API (MAILPIT_URL, the test override's mail
#     catcher) the way a user reads their inbox, POST /auth/email/verify ->
#     registration_ticket -> POST /auth/passkeys/register;
#   * the device proof (specs/device-identity.md §6.1): an Ed25519 device key
#     signs "my-secrect/device/v1/<purpose>\n<canonical json>" over the
#     ceremony's challenge — `enroll` the first time, `session-bind` after.
# Never prints codes, tickets, tokens or keys.
require 'net/http'
require 'json'
require 'openssl'
require 'base64'
require 'uri'

module TestSignup
  CODE = /verification code is (\d{6})/

  module_function

  def b64u(bytes) = Base64.urlsafe_encode64(bytes, padding: false)

  def mailpit = ENV.fetch('MAILPIT_URL')

  # Codes mailed to `email`, oldest first (Mailpit lists newest first).
  def mailed_codes(email)
    query = URI.encode_www_form_component(%(to:"#{email}"))
    list = JSON.parse(Net::HTTP.get(URI("#{mailpit}/api/v1/search?query=#{query}")))
    list.fetch('messages', []).reverse.filter_map do |m|
      JSON.parse(Net::HTTP.get(URI("#{mailpit}/api/v1/message/#{m['ID']}")))['Text'].to_s[CODE, 1]
    end
  end

  def wait_for_code(email, seen)
    deadline = Time.now + 20
    loop do
      codes = mailed_codes(email)
      return codes.last if codes.size > seen
      raise 'no sign-up code reached the test mailbox' if Time.now > deadline
      sleep 0.3
    end
  end

  # An Ed25519 device key held by this test client (OpenSSL, no libsodium).
  class DeviceKey
    attr_accessor :id

    def initialize
      @key = OpenSSL::PKey.generate_key('ED25519')
    end

    def public_key = TestSignup.b64u(@key.raw_public_key)

    # `device` field of POST /auth/passkeys/verify for this ceremony.
    def proof(challenge)
      return { id: id, signature: sign('session-bind', challenge: challenge, device_id: id) } if id

      { public_key: public_key, signature: sign('enroll', challenge: challenge, public_key: public_key) }
    end

    def sign(purpose, payload)
      body = payload.sort_by { |k, _| k.to_s }.map { |k, v| %("#{k}":"#{v}") }.join(',')
      TestSignup.b64u(@key.sign(nil, "my-secrect/device/v1/#{purpose}\n{#{body}}"))
    end
  end

  # Full sign-up: email code -> ticket -> passkey registration bound to `device`.
  # `api` is the caller's api(method, path, body:, token:) -> [status, json].
  # Returns [verify response (token, device_id, ...), the registered credential].
  def sign_up(api, client, email, device)
    seen = mailed_codes(email).size
    status, = api.call(:post, '/auth/email/request', body: { email: email })
    raise "email/request: HTTP #{status}" unless status == 202
    status, ver = api.call(:post, '/auth/email/verify', body: { email: email, code: wait_for_code(email, seen) })
    raise "email/verify: HTTP #{status}" unless status == 200
    status, opts = api.call(:post, '/auth/passkeys/register', body: { email: email, registration_ticket: ver.fetch('registration_ticket') })
    raise "passkey register options: HTTP #{status}" unless status == 200
    challenge = opts.fetch('creation_options').fetch('challenge')
    credential = client.create(challenge: challenge, user_verified: true)
    status, reg = api.call(:post, '/auth/passkeys/verify',
                           body: { email: email, credential: credential, kind: 'registration', device: device.proof(challenge) })
    raise "passkey register verify: HTTP #{status}" unless status == 200
    device.id = reg['device_id'] or raise 'the session is not bound to a device'
    [reg, credential]
  end
end
