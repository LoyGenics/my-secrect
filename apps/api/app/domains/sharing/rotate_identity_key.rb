module Sharing
  # Replace the caller's identity key (specs/sharing-protocol.md §3). The
  # controller has already required a fresh step-up. Every share the caller
  # owns or receives was wrapped for the old key pair, so all of them are
  # revoked (ciphertext erased) in the same transaction; contacts who
  # pinned the old key get KeyChangedError until they verify again.
  module RotateIdentityKey
    module_function

    # Returns [identity_key, number_of_shares_revoked].
    def call(user:, public_key:, encrypted_secret_key:)
      pk = Wire.public_key!(public_key, field: 'public_key')
      secret = Wire.small_ciphertext!(encrypted_secret_key, field: 'encrypted_secret_key')
      result = user.with_lock do
        key = IdentityKey.find_by(user_id: user.id)
        raise Failure.new(:not_found, 'no_identity_key') unless key
        raise Failure.invalid('public_key is the current key; nothing to rotate') if key.public_key == pk

        key.update!(public_key: pk, encrypted_secret_key: secret)
        now = Time.current
        revoked = ItemShare.for_party(user).where.not(status: 'revoked').update_all(
          status: 'revoked', revoked_at: now, updated_at: now,
          encrypted_payload: nil, encrypted_item_key: nil, encrypted_owner_metadata: nil
        )
        [key, revoked]
      end
      Audit::Log.call(user: user, event_type: 'identity_key_rotated', metadata: { revoked_shares: result.last })
      result
    end
  end
end
