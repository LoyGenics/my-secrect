require 'base64'
require 'rbnacl'

# The CLIENT side of specs/device-identity.md for request specs: real
# Ed25519 keys (RbNaCl) and the signed message built here, independently of
# Authentication::DeviceProof (the code under test). Both are pinned to the
# spec's literal test vector in spec/domains/device_proof_spec.rb.
module DeviceProofHelper
  def new_device_key = RbNaCl::SigningKey.generate

  def b64url(bytes) = Base64.urlsafe_encode64(bytes, padding: false)

  def device_public_key(key) = b64url(key.verify_key.to_bytes)

  def device_message(purpose, payload)
    members = payload.map { |k, v| [k.to_s, v.to_s] }.sort.map { |k, v| %("#{k}":"#{v}") }
    "my-secrect/device/v1/#{purpose}\n{#{members.join(',')}}"
  end

  def device_signature(key, purpose, payload) = b64url(key.sign(device_message(purpose, payload)))

  # `device` param of passkey verify: enrol `key` over `challenge`.
  def enroll_proof(key, challenge, **extra)
    { public_key: device_public_key(key),
      signature: device_signature(key, 'enroll', challenge: challenge, public_key: device_public_key(key)) }.merge(extra)
  end

  # `device` param of passkey verify: bind device `device_id` over `challenge`.
  def bind_proof(key, challenge, device_id)
    { id: device_id, signature: device_signature(key, 'session-bind', challenge: challenge, device_id: device_id) }
  end
end

RSpec.configure { |c| c.include DeviceProofHelper }
