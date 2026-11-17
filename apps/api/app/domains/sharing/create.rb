module Sharing
  # Phase 5 contract. A share = a vault-key envelope for the recipient
  # (created by the OWNER's client, encrypted to the recipient) + permission.
  # The server stores the envelope opaquely and cannot read shared content.
  #
  # Phase C fix (H4): encrypted_key is REQUIRED for an ACTIVE share.
  # A null/missing encrypted_key previously created an ACTIVE share the
  # recipient could never decrypt — a share that looks live but is useless
  # (and invites a client to silently treat it as working). That is now
  # rejected here, before anything is created.
  #
  # HPKE IS STILL NOT IMPLEMENTED. This check only enforces that the
  # client supplied *some* wrapped key; the server cannot verify that the
  # key was actually HPKE-wrapped for this recipient's public key, and
  # it does not attempt to — never fake key exchange. Sharing is NOT
  # production-ready until Phase E/F delivers real HPKE key exchange +
  # recipient key verification. Until then the UI must not present
  # sharing as working end-to-end. See packages/core/src/sharing.ts.
  module Create
    module_function
    def call(owner:, vault_id:, recipient_email:, permission: 'read', encrypted_key: nil)
      raise ArgumentError, 'permission must be read or write' unless %w[read write].include?(permission.to_s)
      raise ArgumentError, 'encrypted_key is required for an active share (HPKE key exchange not yet implemented — do not create keyless active shares)' if encrypted_key.blank?
      vault = owner.vaults.find(vault_id)
      recipient = User.find_by(email: recipient_email.to_s.strip.downcase)
      raise ArgumentError, 'recipient not found' unless recipient
      raise ArgumentError, 'cannot share with yourself' if recipient.id == owner.id
      share = vault.shares.create!(owner: owner, recipient: recipient, permission: permission, status: 'active', encrypted_key: encrypted_key)
      vault.key_envelopes.create!(recipient_id: recipient.id, key_version: vault.key_version, encrypted_key: encrypted_key)
      Audit::Log.call(user: owner, event_type: 'share_created')
      share
    end
  end
end
