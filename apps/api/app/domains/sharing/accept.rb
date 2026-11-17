module Sharing
  # Recipient activates a PENDING share (specs/sharing-protocol.md §6 step 3).
  # The recipient's client calls this only after it verified the owner's
  # fingerprint, pinned the key and opened the wrapped Share Key with it.
  # The server cannot check the crypto; it enforces the state machine and
  # that the owner key the recipient pinned is the one the share was made
  # under and is still the owner's registered key.
  module Accept
    module_function

    def call(share:, user:, owner_public_key:)
      raise Failure.forbidden('forbidden') unless share.recipient?(user)

      presented_key = Wire.public_key!(owner_public_key, field: 'owner_public_key')
      share.with_lock do
        raise Failure.forbidden('share_revoked') if share.revoked?
        raise Failure.forbidden('share_expired') if share.expired?
        raise Failure.conflict('share_not_pending') unless share.pending?
        raise Failure.conflict('owner_key_mismatch') unless presented_key == share.owner_public_key
        raise Failure.conflict('owner_key_mismatch') unless registered_key(share.owner_id) == share.owner_public_key
        raise Failure.conflict('recipient_key_mismatch') unless registered_key(user.id) == share.recipient_public_key

        share.update!(status: 'active', accepted_at: Time.current)
      end
      Audit::Log.call(user: user, event_type: 'share_accepted', metadata: { share_id: share.id })
      share
    end

    def registered_key(user_id) = IdentityKey.where(user_id: user_id).pick(:public_key)
  end
end
