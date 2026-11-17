module Sharing
  # Write-once registration of the caller's X25519 identity key
  # (specs/sharing-protocol.md §3). The same public key again is idempotent
  # and keeps the stored ciphertext; a different key is 409 — v1 has no
  # rotation, so a second device must load the existing identity instead.
  module RegisterIdentityKey
    module_function

    # Returns [identity_key, created].
    def call(user:, public_key:, encrypted_secret_key:)
      pk = Wire.public_key!(public_key, field: 'public_key')
      secret = Wire.small_ciphertext!(encrypted_secret_key, field: 'encrypted_secret_key')
      result = user.with_lock do
        existing = IdentityKey.find_by(user_id: user.id)
        raise Failure.conflict('identity_key_exists') if existing && existing.public_key != pk
        next [existing, false] if existing

        [IdentityKey.create!(user: user, public_key: pk, encrypted_secret_key: secret), true]
      end
      Audit::Log.call(user: user, event_type: 'identity_key_registered') if result.last
      result
    end
  end
end
