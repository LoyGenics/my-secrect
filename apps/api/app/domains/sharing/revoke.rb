module Sharing
  # Owner revokes, or recipient declines/leaves (specs/sharing-protocol.md §7).
  # Future access stops and the server erases the share's ciphertext, wrapped
  # key and owner metadata. It cannot erase what the recipient already
  # decrypted on their device — the UI says so. Idempotent.
  module Revoke
    module_function

    def call(share:, user:)
      revoked_now = share.with_lock do
        next false if share.revoked?

        share.update!(
          status: 'revoked', revoked_at: Time.current,
          encrypted_payload: nil, encrypted_item_key: nil, encrypted_owner_metadata: nil
        )
        true
      end
      if revoked_now
        Audit::Log.call(
          user: user, event_type: 'share_revoked',
          metadata: { share_id: share.id, by: share.owner?(user) ? 'owner' : 'recipient' }
        )
      end
      share
    end
  end
end
