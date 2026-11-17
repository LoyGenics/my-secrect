module EncryptedRecords
  # Soft delete: an encrypted tombstone. The last ciphertext version is
  # kept so a mistaken delete can be restored from version history.
  module Delete
    module_function
    # base_revision must match the item, same rule as upsert. A missing
    # or stale value raises Upsert::RevisionConflict and writes nothing,
    # so a replay cannot append a second tombstone. signature is optional
    # opaque bytes and is not authenticated.
    def call(vault:, item_id:, base_revision:, device: nil, signature: nil)
      vault.transaction do
        vault.lock! # lock order: vault, then item (see AppendEvent)
        item = vault.items.lock.find(item_id)
        supplied = base_revision.presence
        if supplied.nil? || item.current_revision != supplied.to_i
          raise Upsert::RevisionConflict, item.current_revision
        end
        item.current_revision += 1
        item.deleted_at = Time.current
        item.save!
        event = AppendEvent.call(vault: vault, item: item, operation: 'delete', device: device, signature: signature)
        { item_id: item.id, revision: item.current_revision, sequence: event.sequence, deleted_at: item.deleted_at }
      end
    end
  end
end
