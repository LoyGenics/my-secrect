module Sync
  module Pull
    module_function
    # Append-only log read. Cursor = last sequence the device has applied.
    # The device verifies AEAD + revision + checkpoint before applying.
    def call(vault:, since: nil)
      since_seq = since.to_i
      events = vault.sync_events.where('sequence > ?', since_seq).order(:sequence).limit(500)
      {
        events: events.map { |e| { id: e.id, vault_id: e.vault_id, sequence: e.sequence, item_id: e.item_id, revision: e.revision, operation: e.operation, device_id: e.device_id, created_at: e.created_at } },
        next_cursor: events.last&.sequence
      }
    end
  end
end
