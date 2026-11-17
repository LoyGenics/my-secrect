module EncryptedRecords
  # Soft delete: an encrypted tombstone. The last ciphertext version is
  # kept so a mistaken delete can be restored from version history.
  module Delete
    module_function
    def call(vault:, item_id:, device: nil, signature: nil)
      vault.transaction do
        item = vault.items.lock.find(item_id)
        item.current_revision += 1
        item.deleted_at = Time.current
        item.save!
        seq = (vault.sync_events.maximum(:sequence) || 0) + 1
        vault.sync_events.create!(sequence: seq, item_id: item.id, revision: item.current_revision, operation: 'delete', device: device, signature: signature)
        { item_id: item.id, revision: item.current_revision, sequence: seq, deleted_at: item.deleted_at }
      end
    end
  end
end
