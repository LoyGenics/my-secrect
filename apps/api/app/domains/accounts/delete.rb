module Accounts
  # Hard-deletes one account and the rows that belong to it.
  #
  # Sessions are removed first so every bearer token for the account
  # stops verifying. User dependent: :destroy is not a complete cascade:
  # sessions and MFA challenges reference devices, audit events reference
  # devices, and sync events keep a NOT NULL item_id, so Item's
  # dependent: :nullify cannot clear them. Children are removed in
  # foreign-key order with delete_all / update_all, which does not load
  # token digests or vault ciphertext. No email, token, or ciphertext
  # is written to the log.
  module Delete
    module_function

    def call(user:)
      user.with_lock do
        device_ids = user.devices.pluck(:id)
        vault_ids = user.vaults.pluck(:id)

        user.sessions.delete_all
        MfaChallenge.where(user_id: user.id).delete_all
        PasskeyChallenge.where(email: user.email).delete_all
        RecoveryChallenge.where(user_id: user.id).delete_all
        RecoveryVerifier.where(user_id: user.id).delete_all
        RecoveryCode.where(user_id: user.id).delete_all
        Authenticator.where(user_id: user.id).delete_all

        unless device_ids.empty?
          AuditEvent.where(device_id: device_ids).update_all(device_id: nil)
          SyncEvent.where(device_id: device_ids).update_all(device_id: nil)
          DeviceCheckpoint.where(device_id: device_ids).delete_all
        end

        Share.where(owner_id: user.id).or(Share.where(recipient_id: user.id)).delete_all
        KeyEnvelope.where(recipient_id: [user.id, *device_ids]).delete_all

        unless vault_ids.empty?
          Share.where(vault_id: vault_ids).delete_all
          SyncEvent.where(vault_id: vault_ids).delete_all
          DeviceCheckpoint.where(vault_id: vault_ids).delete_all
          KeyEnvelope.where(vault_id: vault_ids).delete_all

          item_ids = Item.where(vault_id: vault_ids).pluck(:id)
          unless item_ids.empty?
            SyncEvent.where(item_id: item_ids).delete_all
            ItemVersion.where(item_id: item_ids).delete_all
            Item.where(id: item_ids).delete_all
          end

          blob_ids = Blob.where(vault_id: vault_ids).pluck(:id)
          unless blob_ids.empty?
            BlobPart.where(blob_id: blob_ids).delete_all
            Blob.where(id: blob_ids).delete_all
          end

          Vault.where(id: vault_ids).delete_all
        end

        Device.where(id: device_ids).delete_all unless device_ids.empty?
        user.destroy!
      end
    end
  end
end
