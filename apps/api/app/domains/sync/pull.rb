module Sync
  module Pull
    module_function
    # Append-only log read. Cursor = last sequence the device has applied.
    #
    # Phase C fix (H1): every upsert event now carries the ciphertext the
    # client needs to apply it — encrypted_payload + encrypted_item_key
    # (+ encryption_version), read from the ItemVersion at the event's
    # exact revision. A pull without these fields cannot be applied: the
    # client (packages/sync applyRemoteEvents) skips such events, which is
    # why sync was broken by construction before this fix.
    #
    # Delete events carry no ciphertext (there is nothing to decrypt);
    # they are marked tombstone: true and the client applies the tombstone
    # only when event.revision is newer than local. The server NEVER
    # returns plaintext titles/tags/types/relations — ciphertext only.
    #
    # Versions are preloaded in ONE query (no N+1 over the page).
    def call(vault:, since: nil)
      since_seq = since.to_i
      since_seq = 0 if since_seq.negative?
      events = vault.sync_events.where('sequence > ?', since_seq).order(:sequence).limit(500).to_a
      upserts = events.select { |e| e.operation == 'upsert' }
      versions = ItemVersion.where(item_id: upserts.map(&:item_id))
                            .index_by { |v| [v.item_id, v.revision] }
      {
        events: events.map do |e|
          version = versions[[e.item_id, e.revision]] if e.operation == 'upsert'
          {
            id: e.id,
            vault_id: e.vault_id,
            sequence: e.sequence,
            item_id: e.item_id,
            revision: e.revision,
            operation: e.operation,
            tombstone: e.operation == 'delete',
            device_id: e.device_id,
            signature: e.signature ? Base64.strict_encode64(e.signature) : nil,
            encrypted_payload: version&.encrypted_payload ? Base64.strict_encode64(version.encrypted_payload) : nil,
            encrypted_item_key: version&.encrypted_item_key ? Base64.strict_encode64(version.encrypted_item_key) : nil,
            encryption_version: version&.encryption_version,
            created_at: e.created_at
          }
        end,
        next_cursor: events.last&.sequence
      }
    end
  end
end
