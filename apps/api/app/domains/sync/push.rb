module Sync
  module Push
    class RevisionConflict < StandardError
      attr_reader :current_revision
      def initialize(current_revision) = (@current_revision = current_revision; super('revision_conflict'))
    end
    module_function
    # Phase C fix — sync sequence race: Upsert/Delete assign the next
    # sequence as (max(sequence) + 1). Under concurrent pushes two writers
    # could read the same max and collide on the unique (vault_id,
    # sequence) index. The whole push is therefore serialised per vault
    # with `vault.with_lock` (SELECT ... FOR UPDATE on the vault row),
    # so max+1 is computed under the lock. As belt-and-braces, a unique-
    # violation from any writer that bypassed this path (e.g. direct
    # item upserts) is retried once instead of surfacing a 500.
    # The server still NEVER decrypts, merges, or last-write-wins:
    # a stale base_revision raises RevisionConflict (409) and the
    # client resolves it after decryption (see packages/sync).
    def call(vault:, item_id:, base_revision:, operation:, encrypted_payload:, encrypted_item_key:, encryption_version: 1, device: nil, signature: nil)
      raise ArgumentError, 'operation must be upsert or delete' unless %w[upsert delete].include?(operation.to_s)
      if operation.to_s == 'upsert'
        raise ArgumentError, 'encrypted_payload required' if encrypted_payload.blank?
        raise ArgumentError, 'encrypted_item_key required' if encrypted_item_key.blank?
      end
      attempts = 0
      begin
        vault.with_lock do
          return EncryptedRecords::Delete.call(vault: vault, item_id: item_id, device: device) if operation == 'delete'
          EncryptedRecords::Upsert.call(vault: vault, item_id: item_id, base_revision: base_revision, encrypted_payload: encrypted_payload, encrypted_item_key: encrypted_item_key, encryption_version: encryption_version, device: device)
        end
      rescue ActiveRecord::RecordNotUnique
        attempts += 1
        retry if attempts < 2
        raise
      end
    rescue EncryptedRecords::Upsert::RevisionConflict => e
      raise RevisionConflict, e.current_revision
    end
  end
end
