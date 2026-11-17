require 'base64'

module Recovery
  # Recovery verifiers: Ed25519 VERIFY keys (public halves) a user
  # registers while authenticated + stepped up, so that later — when
  # they have lost their session — they can prove account ownership by
  # signing a recovery challenge (Recovery::Verify). The private half
  # never leaves the user's device; the server stores only the public
  # key and can never forge a proof or derive a vault key from it.
  # Registering a new verifier revokes all previous ones.
  #
  # Only the v1 derivation may be registered (specs/recovery-protocol.md:
  # the Ed25519 seed is HKDF(recovery key, "my-secrect/recovery-verifier/v1"),
  # never the recovery key itself). The server cannot check how a public
  # key was derived; the declared derivation is recorded so v0 leftovers
  # can be found and retired, and a client that does not declare v1 is
  # refused rather than allowed to create new v0 verifiers.
  module Verifiers
    class Error < StandardError; end
    class UnsupportedDerivation < Error; end

    module_function

    def register(user:, public_key:, derivation:)
      raise UnsupportedDerivation, 'unsupported derivation' unless derivation == RecoveryVerifier::DERIVATION_V1
      raw = Authentication::SecretEncryptor.decode_base64_loose(public_key)
      raise Error, 'invalid public key' unless raw.bytesize == 32
      verifier = nil
      ActiveRecord::Base.transaction do
        user.recovery_verifiers.active.update_all(revoked_at: Time.current)
        verifier = user.recovery_verifiers.create!(public_key: Base64.strict_encode64(raw), derivation: derivation)
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
        { id: verifier.id, fingerprint: verifier.fingerprint, derivation: verifier.derivation,
          created_at: verifier.created_at }
      end
    end
  end
end
