require 'base64'

module Recovery
  # Recovery verifiers: Ed25519 VERIFY keys (public halves) a user
  # registers while authenticated + stepped up, so that later — when
  # they have lost their session — they can prove account ownership by
  # signing a recovery challenge (Recovery::Verify). The private half
  # never leaves the user's device; the server stores only the public
  # key and can never forge a proof or derive a vault key from it.
  # Registering a new verifier revokes all previous ones.
  module Verifiers
    class Error < StandardError; end

    module_function

    def register(user:, public_key:)
      raw = Authentication::SecretEncryptor.decode_base64_loose(public_key)
      raise Error, 'invalid public key' unless raw.bytesize == 32
      verifier = nil
      ActiveRecord::Base.transaction do
        user.recovery_verifiers.active.update_all(revoked_at: Time.current)
        verifier = user.recovery_verifiers.create!(public_key: Base64.strict_encode64(raw))
      end
      Audit::Log.call(user: user, event_type: 'recovery_verifier_registered')
      verifier
    rescue ArgumentError
      raise Error, 'invalid public key'
    end

    # Fingerprints + created_at only. The full key is public by nature,
    # but minimal output keeps the surface small.
    def list(user:)
      user.recovery_verifiers.active.order(created_at: :desc).map do |verifier|
        { id: verifier.id, fingerprint: verifier.fingerprint, created_at: verifier.created_at }
      end
    end
  end
end
