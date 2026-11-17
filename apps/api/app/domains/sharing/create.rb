module Sharing
  # Phase 5 contract. A share = a vault-key envelope for the recipient
  # (created by the OWNER's client, encrypted to the recipient) + permission.
  # The server stores the envelope opaquely and cannot read shared content.
  #
  # Fail closed: encrypted_key is an unverified opaque blob. There is no
  # recipient public key, no HPKE, no crypto_box, and no proof the blob is
  # a real wrap. A non-blank blob must not activate sharing. This method
  # always persists status "pending" and never "active".
  # Blank encrypted_key is still rejected so a keyless envelope is not
  # stored. Sharing is not live.
  module Create
    module_function
    def call(owner:, vault_id:, recipient_email:, permission: 'read', encrypted_key: nil)
      raise ArgumentError, 'permission must be read or write' unless %w[read write].include?(permission.to_s)
      raise ArgumentError, 'encrypted_key is required' if encrypted_key.blank?
      vault = owner.vaults.find(vault_id)
      recipient = User.find_by(email: recipient_email.to_s.strip.downcase)
      raise ArgumentError, 'recipient not found' unless recipient
      raise ArgumentError, 'cannot share with yourself' if recipient.id == owner.id
      share = vault.shares.create!(owner: owner, recipient: recipient, permission: permission, status: 'pending', encrypted_key: encrypted_key)
      # key_envelopes.encrypted_key is non-null. The row is an unverified
      # opaque blob; storing it does not activate the share or grant access.
      vault.key_envelopes.create!(recipient_id: recipient.id, key_version: vault.key_version, encrypted_key: encrypted_key)
      Audit::Log.call(user: owner, event_type: 'share_created')
      share
    end
  end
end
