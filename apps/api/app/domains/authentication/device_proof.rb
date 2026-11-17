require 'base64'
require 'digest'
require 'rbnacl'
require 'securerandom'

module Authentication
  # Device proof-of-possession — specs/device-identity.md is normative;
  # this module implements it. Read the spec before changing anything here.
  #
  # A device is an Ed25519 public key generated on the client. The server
  # associates a device with an account (enrol) or a session with a device
  # (bind) ONLY after verifying, with RbNaCl, a signature over
  #
  #   "my-secrect/device/v1/" || purpose || "\n" || canonical_json(payload)
  #
  # where the payload names a fresh, single-use, server-issued challenge.
  # The server builds that message itself from its own state (the stored
  # challenge, the device id from the database, the canonicalised public
  # key) — it never verifies a client-supplied message.
  #
  # Two challenge sources (spec §5):
  #   * sign-in: the WebAuthn challenge of the passkey ceremony in the same
  #     request (sign_in_proof!). The passkey verification consumes it, and
  #     the proof is only looked at after that verification succeeded.
  #   * explicit: POST /api/v1/devices/challenges (issue_challenge!), stored
  #     as SHA-256 only, bound to the user, the requesting session and the
  #     purpose, TTL 2 minutes, consumed BEFORE the signature is checked.
  #
  # Failure is one generic VerificationError (audited as
  # device_bind_failed with the purpose only — never the challenge,
  # signature or key). Never weaken: no "skip verification" path, no
  # client-chosen key for session-bind, no reuse of a consumed challenge.
  module DeviceProof
    class VerificationError < StandardError; end
    class AlreadyBound < StandardError; end
    # The session's passkey must be re-approved before it can enrol a
    # device (spec §6.3, durable revocation).
    class ApprovalRequired < StandardError; end

    DOMAIN = 'my-secrect/device/v1/'
    # v1 purpose registry (spec §4). 'sync-event' is reserved for the sync
    # protocol and is NOT accepted here until that spec defines its payload.
    PURPOSES = %w[enroll session-bind].freeze
    PURPOSE_FORMAT = /\A[a-z][a-z0-9-]{0,31}\z/
    PAYLOAD_KEY_FORMAT = /\A[a-z_]+\z/
    # Printable ASCII except '"' (0x22) and '\' (0x5C): nothing ever needs
    # JSON escaping, so every implementation serialises identically.
    PAYLOAD_VALUE_FORMAT = /\A[\x20\x21\x23-\x5B\x5D-\x7E]*\z/
    ALG = 'ed25519'
    PUBLIC_KEY_BYTES = 32
    SIGNATURE_BYTES = 64
    CHALLENGE_TTL = 2.minutes

    module_function

    # -- message format (generic: reused for future purposes) -------------

    def message(purpose:, payload:)
      raise ArgumentError, 'invalid purpose' unless PURPOSE_FORMAT.match?(purpose.to_s)
      "#{DOMAIN}#{purpose}\n#{canonical_json(payload)}"
    end

    # Flat object, keys sorted by byte value, string values only, no
    # whitespace, no escaping (spec §3). Raises ArgumentError instead of
    # escaping anything.
    def canonical_json(payload)
      pairs = payload.map { |key, value| [key.to_s, value] }.sort_by(&:first)
      raise ArgumentError, 'duplicate payload key' unless pairs.map(&:first).uniq.size == pairs.size
      members = pairs.map do |key, value|
        raise ArgumentError, 'invalid payload key' unless PAYLOAD_KEY_FORMAT.match?(key)
        raise ArgumentError, 'invalid payload value' unless value.is_a?(String) && PAYLOAD_VALUE_FORMAT.match?(value)
        %("#{key}":"#{value}")
      end
      "{#{members.join(',')}}"
    end

    # True only for a valid Ed25519 signature by `public_key_bytes` over
    # message(purpose, payload). Any malformed input is simply false.
    def signature_valid?(public_key_bytes:, purpose:, payload:, signature:)
      sig = decode(signature)
      return false unless sig&.bytesize == SIGNATURE_BYTES && public_key_bytes.to_s.bytesize == PUBLIC_KEY_BYTES
      RbNaCl::VerifyKey.new(public_key_bytes.to_s.b).verify(sig, message(purpose: purpose, payload: payload))
    rescue RbNaCl::BadSignatureError, RbNaCl::LengthError, RbNaCl::CryptoError, ArgumentError
      false
    end

    def encode(bytes) = Base64.urlsafe_encode64(bytes, padding: false)

    # -- sign-in (inline) proof --------------------------------------------

    # Check the optional `device` field of a passkey sign-in. `challenge`
    # is the WebAuthn challenge that ceremony consumed. Writes nothing.
    # Returns nil (no proof: the session will be unbound),
    # { device: Device } (bind an existing device) or
    # { enroll: { public_key:, platform:, name_encrypted: } } (new device).
    # Raises VerificationError when a proof is present but does not verify.
    def sign_in_proof!(user:, challenge:, proof:)
      return nil if proof.blank?
      fields = proof.respond_to?(:to_unsafe_h) ? proof.to_unsafe_h : proof
      fail!(user: user, purpose: 'sign-in') unless fields.is_a?(Hash)
      fields = fields.stringify_keys

      if fields['id'].present?
        device = bindable_device(user: user, device_id: fields['id'])
        ok = device && signature_valid?(public_key_bytes: device.public_key, purpose: 'session-bind',
                                        payload: { challenge: challenge, device_id: device.id },
                                        signature: fields['signature'])
        fail!(user: user, purpose: 'session-bind') unless ok
        { device: device }
      else
        public_key = decode_public_key(fields['public_key'])
        ok = public_key && signature_valid?(public_key_bytes: public_key, purpose: 'enroll',
                                            payload: { challenge: challenge, public_key: encode(public_key) },
                                            signature: fields['signature'])
        fail!(user: user, purpose: 'enroll') unless ok
        { enroll: { public_key: encode(public_key), platform: fields['platform'].presence,
                    name_encrypted: fields['name_encrypted'].presence } }
      end
    end

    # Turn a verified sign_in_proof! result into the session's device:
    # creates the device for an enrolment, re-checks an existing device is
    # still active. nil stays nil (unbound session).
    # `authenticator`: the passkey of this sign-in, recorded on a newly
    # enrolled device so revoking that device can restrict the passkey.
    def device_for!(user:, proof:, authenticator: nil)
      return nil if proof.nil?
      if proof[:device]
        device = bindable_device(user: user, device_id: proof[:device].id)
        fail!(user: user, purpose: 'session-bind') unless device
        Audit::Log.call(user: user, device: device, event_type: 'device_bound', metadata: { via: 'sign_in' })
        return device
      end
      enrol = proof[:enroll]
      key = decode(enrol[:public_key])
      fail!(user: user, purpose: 'enroll') if key_ever_enrolled?(key)
      device = Devices::Enroll.call(user: user, public_key: key, public_key_alg: ALG, authenticator: authenticator,
                                    platform: enrol[:platform], name_encrypted: enrol[:name_encrypted])
      Audit::Log.call(user: user, device: device, event_type: 'device_bound', metadata: { via: 'sign_in' })
      device
    rescue ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique
      fail!(user: user, purpose: 'enroll')
    end

    # -- explicit (authenticated) flow -------------------------------------

    def issue_challenge!(session:, purpose:)
      raise VerificationError, 'unknown purpose' unless PURPOSES.include?(purpose.to_s)
      raw = SecureRandom.urlsafe_base64(32) # 32 bytes -> 43 chars, no padding
      ::DeviceChallenge.create!(user_id: session.user_id, session_id: session.id, purpose: purpose.to_s,
                                challenge_digest: Digest::SHA256.hexdigest(raw),
                                expires_at: Time.current + CHALLENGE_TTL)
      { challenge: raw, purpose: purpose.to_s, expires_in: CHALLENGE_TTL.to_i }
    end

    # POST /devices/enroll: proof of possession of `public_key` over a
    # challenge this session requested for 'enroll'. Step-up is enforced
    # by the controller. Binds the session to the new device only if the
    # session is still unbound. Returns the Device.
    def enroll!(session:, public_key:, challenge:, signature:, platform: nil, name_encrypted: nil)
      user = session.user
      raise ApprovalRequired, 'passkey needs re-approval' if session.authenticator&.reapproval_required?
      raw = consume_challenge(session: session, purpose: 'enroll', challenge: challenge)
      key = decode_public_key(public_key)
      ok = raw && key && signature_valid?(public_key_bytes: key, purpose: 'enroll',
                                          payload: { challenge: raw, public_key: encode(key) }, signature: signature)
      fail!(user: user, purpose: 'enroll') unless ok
      fail!(user: user, purpose: 'enroll') if key_ever_enrolled?(key)
      device = Devices::Enroll.call(user: user, public_key: key, public_key_alg: ALG, authenticator: session.authenticator,
                                    platform: platform, name_encrypted: name_encrypted)
      bind_session(session: session, device: device, via: 'enroll')
      device
    rescue ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique
      fail!(user: user, purpose: 'enroll')
    end

    # POST /devices/:id/bind: proof by device `device_id` over a challenge
    # this session requested for 'session-bind'. A bound session is never
    # re-bound (AlreadyBound). Returns the Device.
    def bind!(session:, device_id:, challenge:, signature:)
      raise AlreadyBound, 'session already bound to a device' if session.device_id.present?
      user = session.user
      raw = consume_challenge(session: session, purpose: 'session-bind', challenge: challenge)
      device = bindable_device(user: user, device_id: device_id)
      ok = raw && device && signature_valid?(public_key_bytes: device.public_key, purpose: 'session-bind',
                                             payload: { challenge: raw, device_id: device.id }, signature: signature)
      fail!(user: user, purpose: 'session-bind') unless ok
      raise AlreadyBound, 'session already bound to a device' unless bind_session(session: session, device: device, via: 'bind')
      device
    end

    # -- internals ---------------------------------------------------------

    # A device key is enrolled at most once, ever: a revoked device's key
    # can never come back as a "new" device (spec §6.3). The partial unique
    # index on devices.public_key enforces the same in the database.
    def key_ever_enrolled?(key_bytes)
      ::Device.exists?(public_key: key_bytes, public_key_alg: ALG)
    end

    # Atomic single-winner consume of a challenge issued to THIS session for
    # THIS purpose. Returns the raw challenge, or nil (missing, expired,
    # used, other session, other purpose) — the caller fails closed.
    def consume_challenge(session:, purpose:, challenge:)
      return nil unless challenge.is_a?(String) && challenge.present?
      now = Time.current
      won = ::DeviceChallenge.where(challenge_digest: Digest::SHA256.hexdigest(challenge), session_id: session.id,
                                    purpose: purpose, consumed_at: nil, expires_at: now..)
                             .update_all(consumed_at: now, updated_at: now)
      won == 1 ? challenge : nil
    end

    # Only an active device of this user with a v1 Ed25519 key. Legacy rows
    # (public_key_alg NULL: the pre-v1 passkey COSE key) never qualify.
    def bindable_device(user:, device_id:)
      user.devices.active.find_by(id: device_id.to_s, public_key_alg: ALG)
    end

    # Bind only if still unbound (one conditional UPDATE). True when bound.
    def bind_session(session:, device:, via:)
      bound = ::Session.where(id: session.id, device_id: nil).update_all(device_id: device.id, updated_at: Time.current) == 1
      return false unless bound
      session.device = device
      Audit::Log.call(user: session.user, device: device, event_type: 'device_bound', metadata: { via: via })
      true
    end

    def decode(value)
      return nil unless value.is_a?(String) && value.present?
      SecretEncryptor.decode_base64_loose(value)
    rescue ArgumentError
      nil
    end

    def decode_public_key(value)
      key = decode(value)
      key if key&.bytesize == PUBLIC_KEY_BYTES
    end

    def fail!(user:, purpose:)
      Audit::Log.call(user: user, event_type: 'device_bind_failed', metadata: { purpose: purpose })
      raise VerificationError, 'device verification failed'
    end
  end
end
