module EncryptedRecords
  # Soft delete: an encrypted tombstone. The last ciphertext version is
  # kept so the item can be restored: an upsert with base_revision = the
  # tombstone's revision brings it back (see Upsert for which ciphertext).
  # There is no server-side purge of a single item.
  module Delete
    module_function
    # base_revision must match the item, same rule as upsert. A missing or
    # different value raises Upsert::RevisionConflict and writes nothing.
    # Replay: if the event at base_revision + 1 is already a delete of this
    # item (the response was lost, or another device deleted from the same
    # base), or the item is already a tombstone at base_revision, nothing is
    # written and that tombstone comes back with replayed: true — never a
    # second tombstone. signature is optional opaque bytes, not authenticated.
    def call(vault:, item_id:, base_revision:, device: nil, signature: nil)
      vault.transaction do
        vault.lock! # lock order: vault, then item (see AppendEvent)
        item = vault.items.lock.find(item_id)
        supplied = base_revision.presence
        raise Upsert::RevisionConflict, item.current_revision if supplied.nil?
        tombstone = existing_tombstone(item, supplied.to_i)
        if tombstone
          { item_id: item.id, revision: tombstone.revision, sequence: tombstone.sequence, replayed: true }
        else
          raise Upsert::RevisionConflict, item.current_revision unless item.current_revision == supplied.to_i
          item.current_revision += 1
          item.deleted_at = Time.current
          item.save!
          event = AppendEvent.call(vault: vault, item: item, operation: 'delete', device: device, signature: signature)
          { item_id: item.id, revision: item.current_revision, sequence: event.sequence, deleted_at: item.deleted_at }
        end
      end
    end

    def existing_tombstone(item, base)
      revision = item.deleted? && item.current_revision == base ? base : base + 1
      item.sync_events.find_by(revision: revision, operation: 'delete')
    end
  end
end
