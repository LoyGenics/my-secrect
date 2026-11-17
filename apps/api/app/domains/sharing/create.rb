module Sharing
  # Owner creates a PENDING share with revision 1 of the encrypted record
  # (specs/sharing-protocol.md §6 step 1). The owner's client has already
  # pinned the recipient key after an out-of-band fingerprint check and
  # encrypted under it; here the server only cross-checks that the key it
  # was given is the recipient's registered key, so stale clients fail
  # closed (409). The share is never active until the recipient accepts.
  module Create
    UUID_V4 = /\A\h{8}-\h{4}-4\h{3}-[89ab]\h{3}-\h{12}\z/i

    module_function

    def call(owner:, id:, recipient_id:, recipient_public_key:, permission:, expires_at:,
             encrypted_payload:, encrypted_item_key:, encrypted_owner_metadata:)
      raise Failure.invalid('id must be a UUID v4 chosen by the client') unless id.is_a?(String) && UUID_V4.match?(id)
      raise Failure.invalid('permission must be read or write') unless ItemShare::PERMISSIONS.include?(permission)

      owner_key = IdentityKey.find_by(user_id: owner.id)
      raise Failure.invalid('register your identity key before sharing') unless owner_key

      recipient = User.find_by(id: recipient_id, status: 'active')
      raise Failure.invalid('recipient not found') unless recipient
      raise Failure.invalid('cannot share with yourself') if recipient.id == owner.id

      recipient_key = IdentityKey.find_by(user_id: recipient.id)
      raise Failure.invalid('recipient has no identity key') unless recipient_key

      presented_key = Wire.public_key!(recipient_public_key, field: 'recipient_public_key')
      raise Failure.conflict('recipient_key_mismatch') unless presented_key == recipient_key.public_key

      share = ItemShare.create!(
        id: id, owner: owner, recipient: recipient, permission: permission, status: 'pending',
        expires_at: parse_expiry(expires_at),
        owner_public_key: owner_key.public_key, recipient_public_key: recipient_key.public_key,
        revision: 1, last_writer_id: owner.id,
        encrypted_payload: Wire.payload!(encrypted_payload),
        encrypted_item_key: Wire.wrapped_share_key!(encrypted_item_key),
        encrypted_owner_metadata: Wire.small_ciphertext!(encrypted_owner_metadata, field: 'encrypted_owner_metadata')
      )
      Audit::Log.call(user: owner, event_type: 'share_created', metadata: { share_id: share.id, permission: permission })
      share
    rescue ActiveRecord::RecordNotUnique
      raise Failure.conflict('share_id_taken')
    end

    # nil / '' = no expiry. Otherwise ISO 8601, strictly in the future.
    def parse_expiry(value)
      return nil if value.blank?

      time = Time.iso8601(value.to_s)
      raise Failure.invalid('expires_at must be in the future') unless time > Time.current

      time
    rescue ArgumentError
      raise Failure.invalid('expires_at must be ISO 8601')
    end
  end
end
