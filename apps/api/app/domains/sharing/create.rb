module Sharing
  # Phase 5 contract. A share = a vault-key envelope for the recipient
  # (created by the OWNER's client, encrypted to the recipient) + permission.
  # The server stores the envelope opaquely and cannot read shared content.
  module Create
    module_function
    def call(owner:, vault_id:, recipient_email:, permission: 'read', encrypted_key: nil)
      vault = owner.vaults.find(vault_id)
      recipient = User.find_by(email: recipient_email.to_s.strip.downcase)
      raise ArgumentError, 'recipient not found' unless recipient
      raise ArgumentError, 'cannot share with yourself' if recipient.id == owner.id
      share = vault.shares.create!(owner: owner, recipient: recipient, permission: permission, status: 'active', encrypted_key: encrypted_key)
      vault.key_envelopes.create!(recipient_id: recipient.id, key_version: vault.key_version, encrypted_key: encrypted_key) if encrypted_key.present?
      Audit::Log.call(user: owner, event_type: 'share_created')
      share
    end
  end
end
