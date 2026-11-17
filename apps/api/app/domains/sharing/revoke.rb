module Sharing
  module Revoke
    module_function
    # Revocation deletes the recipient's key envelope; already-synced
    # ciphertext on their device cannot be remotely wiped — the client
    # must delete local copies on next sync. Document this limit to users.
    def call(share:)
      share.update!(status: 'revoked')
      KeyEnvelope.where(vault_id: share.vault_id, recipient_id: share.recipient_id).delete_all
      Audit::Log.call(user: share.owner, event_type: 'share_revoked')
      share
    end
  end
end
