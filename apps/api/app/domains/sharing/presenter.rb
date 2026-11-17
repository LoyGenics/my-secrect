module Sharing
  # The only shapes the API returns for shares: ids, emails of the two
  # parties, public keys, state, and ciphertext. Never plaintext, never a
  # secret key. encrypted_owner_metadata is shown to the owner only.
  module Presenter
    module_function

    def share(share, viewer:)
      owner = share.owner?(viewer)
      {
        id: share.id,
        role: owner ? 'owner' : 'recipient',
        owner: { id: share.owner_id, email: share.owner.email },
        recipient: { id: share.recipient_id, email: share.recipient.email },
        permission: share.permission,
        status: share.status,
        expires_at: share.expires_at,
        expired: share.expired?,
        revision: share.revision,
        last_writer_id: share.last_writer_id,
        owner_public_key: Wire.encode(share.owner_public_key),
        recipient_public_key: Wire.encode(share.recipient_public_key),
        encrypted_owner_metadata: owner ? Wire.encode(share.encrypted_owner_metadata) : nil,
        created_at: share.created_at,
        accepted_at: share.accepted_at,
        revoked_at: share.revoked_at
      }
    end

    def record(share, include_payload:)
      {
        share_id: share.id,
        revision: share.revision,
        last_writer_id: share.last_writer_id,
        encrypted_item_key: Wire.encode(share.encrypted_item_key),
        encrypted_payload: include_payload ? Wire.encode(share.encrypted_payload) : nil
      }
    end
  end
end
