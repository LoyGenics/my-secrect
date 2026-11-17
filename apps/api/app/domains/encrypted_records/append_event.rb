module EncryptedRecords
  # The only writer of sync_events. Call it inside the transaction that wrote
  # the item change, after bumping item.current_revision.
  #
  # Sequences are per vault, start at 1 and are gap-free. The next one is
  # max(sequence) + 1, read while this transaction holds the vault row lock
  # (SELECT ... FOR UPDATE), so concurrent writers to one vault queue on that
  # lock: sequence N is committed — or rolled back, which frees N — before
  # the next writer reads max. A reader paging with `since = N` therefore
  # never misses an event that commits later with a lower sequence.
  #
  # Upsert and Delete take the same lock before touching the item (lock
  # order: vault, then item); locking again here is a no-op for them and
  # keeps allocation correct for any other caller. The unique indexes on
  # (vault_id, sequence) and (item_id, revision) are the database backstop.
  module AppendEvent
    module_function

    def call(vault:, item:, operation:, device: nil, signature: nil)
      vault.lock!
      sequence = (vault.sync_events.maximum(:sequence) || 0) + 1
      vault.sync_events.create!(
        sequence: sequence, item_id: item.id, revision: item.current_revision,
        operation: operation, device: device, signature: signature
      )
    end
  end
end
