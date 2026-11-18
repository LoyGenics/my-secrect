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
  #
  # Object storage: every blob part object (the ciphertext chunks; the
  # manifest lives encrypted in the blobs row, not in storage) of the
  # user's vaults is deleted through StorageProvider#delete BEFORE any
  # database row is removed, inside the row lock. If any storage delete
  # fails, nothing in the database is touched, an audit event is written
  # (counts + error class only; never keys' contents or credentials) and
  # StorageDeletionError is raised so the caller can retry. Storage
  # deletes are idempotent, so a retry re-deletes safely. Trade-off: if the
  # DB step fails after storage succeeded, the bytes are already gone but
  # the account remains; the user simply retries deletion.
  module Delete
    class StorageDeletionError < StandardError; end

    module_function

    # Returns the set of keys deleted so far (skip-list for the second pass).
    def delete_storage_objects!(user:, vault_ids:, already_deleted: [])
      keys = BlobPart.joins(:blob).where(blobs: { vault_id: vault_ids }).pluck(:object_key) - already_deleted
      return already_deleted if keys.empty?

      provider = Blobs.storage_provider
      failed = 0
      error_classes = []
      keys.each do |key|
        provider.delete(object_key: key)
      rescue StandardError => e
        failed += 1
        error_classes << e.class.name
      end
      return already_deleted | keys if failed.zero?

      Audit::Log.call(user: user, event_type: 'account_deletion_storage_failed',
                      metadata: { failed_objects: failed, total_objects: keys.size, error_classes: error_classes.uniq })
      raise StorageDeletionError, "#{failed} of #{keys.size} storage objects could not be deleted; account not deleted, retry"
    end

    def call(user:)
      # Check before removing any encrypted bytes, then again under the user
      # lock so a concurrent checkout cannot leave a recurring charge behind.
      user.with_lock { Billing::DeletionGuard.check!(user: user) }
      # Pass 1 runs OUTSIDE the DB transaction so a failure's audit event
      # is not rolled back with it. Pass 2 (inside the lock) only catches
      # parts created between pass 1 and the lock.
      pre_vault_ids = user.vaults.pluck(:id)
      deleted = pre_vault_ids.empty? ? [] : delete_storage_objects!(user: user, vault_ids: pre_vault_ids)

      tombstone = user.with_lock do
        Billing::DeletionGuard.check!(user: user)
        device_ids = user.devices.pluck(:id)
        vault_ids = user.vaults.pluck(:id)

        delete_storage_objects!(user: user, vault_ids: vault_ids, already_deleted: deleted) unless vault_ids.empty?

        user.sessions.delete_all
        MfaChallenge.where(user_id: user.id).delete_all
        PasskeyChallenge.where(email: user.email).delete_all
        EmailVerification.where(email: user.email).delete_all
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
        # Same transaction as the deletion: a tombstone exists iff the
        # account is gone. Lets a later backup restore re-apply it
        # (Accounts::Tombstones has the runbook).
        tombstone = Tombstones.record!(user: user)
        user.destroy!
        tombstone
      end
      # Out-of-database copy of the tombstone (hashed id + time, no PII),
      # for when the database itself has to be restored.
      Rails.logger.info(Tombstones.log_line(tombstone))
      # Recorded after the rows are gone, so it has no user and no metadata:
      # the fact of a deletion is kept, nothing that identifies the account.
      Audit::Log.call(event_type: 'account_deleted')
    end
  end
end
