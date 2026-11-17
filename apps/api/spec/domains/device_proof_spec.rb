require 'rails_helper'
require 'rbnacl'

# Authentication::DeviceProof message format against the LITERAL test
# vector in specs/device-identity.md §10 (Ed25519 is deterministic), plus
# the canonical-payload rules and domain separation. Real RbNaCl, no stubs.
RSpec.describe Authentication::DeviceProof do
  let(:seed) { ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'].pack('H*') }
  let(:signing_key) { RbNaCl::SigningKey.new(seed) }
  let(:public_key) { signing_key.verify_key.to_bytes }
  let(:challenge) { 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8' }
  let(:device_id) { '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b' }
  let(:bind_signature) { 'KFN1G09bb_AoNZUh77OX3tjTRdjXEnmZEsCaNUxK4-R6X-qn4m-v6qACHOB0XDLH6LO8e_aztE49ihsRhzyuDQ' }
  let(:enroll_signature) { '53CXmLHTJIzg38orguydfr11SGBznkcKMiGeoyBLz8TNP-q2OPbHH44z0sOYREYQWj59r9AfGJSK8aJOfKJqDA' }

  it 'matches the spec test vector (public key, message bytes, both signatures)' do
    expect(described_class.encode(public_key)).to eq('A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg')
    expect(described_class.message(purpose: 'session-bind', payload: { device_id: device_id, challenge: challenge }))
      .to eq(%(my-secrect/device/v1/session-bind\n{"challenge":"#{challenge}","device_id":"#{device_id}"}))
    expect(described_class.signature_valid?(public_key_bytes: public_key, purpose: 'session-bind',
                                            payload: { challenge: challenge, device_id: device_id },
                                            signature: bind_signature)).to be(true)
    expect(described_class.signature_valid?(public_key_bytes: public_key, purpose: 'enroll',
                                            payload: { challenge: challenge, public_key: described_class.encode(public_key) },
                                            signature: enroll_signature)).to be(true)
  end

  it 'separates purposes: a session-bind signature never verifies as another purpose' do
    payload = { challenge: challenge, device_id: device_id }
    %w[enroll sync-event session-bin].each do |other|
      expect(described_class.signature_valid?(public_key_bytes: public_key, purpose: other, payload: payload,
                                              signature: bind_signature)).to be(false)
    end
  end

  it 'rejects another key, another device id, another challenge, and malformed signatures' do
    other_key = RbNaCl::SigningKey.generate.verify_key.to_bytes
    good = { challenge: challenge, device_id: device_id }
    expect(described_class.signature_valid?(public_key_bytes: other_key, purpose: 'session-bind', payload: good,
                                            signature: bind_signature)).to be(false)
    expect(described_class.signature_valid?(public_key_bytes: public_key, purpose: 'session-bind',
                                            payload: good.merge(device_id: SecureRandom.uuid), signature: bind_signature)).to be(false)
    expect(described_class.signature_valid?(public_key_bytes: public_key, purpose: 'session-bind',
                                            payload: good.merge(challenge: 'x' * 43), signature: bind_signature)).to be(false)
    [nil, '', 'not base64!', bind_signature[0..-3], Base64.urlsafe_encode64('x' * 64)].each do |sig|
      expect(described_class.signature_valid?(public_key_bytes: public_key, purpose: 'session-bind', payload: good,
                                              signature: sig)).to be(false)
    end
    expect(described_class.signature_valid?(public_key_bytes: 'short', purpose: 'session-bind', payload: good,
                                            signature: bind_signature)).to be(false)
  end

  it 'refuses to serialise anything that would need escaping or is not a flat string map' do
    expect(described_class.canonical_json({ 'b' => '2', 'a' => '1' })).to eq('{"a":"1","b":"2"}')
    [{ a: 'quote"' }, { a: 'back\\slash' }, { a: "new\nline" }, { a: 'café' }, { a: 1 }, { a: { b: 'c' } },
     { 'A' => 'x' }, { 'a-b' => 'x' }].each do |payload|
      expect { described_class.canonical_json(payload) }.to raise_error(ArgumentError)
    end
    expect { described_class.canonical_json({ a: 'x', 'a' => 'y' }) }.to raise_error(ArgumentError)
    expect { described_class.message(purpose: "bad\npurpose", payload: {}) }.to raise_error(ArgumentError)
  end
end
