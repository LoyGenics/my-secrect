module EncryptedRecords
  # Append-only, revision-checked upsert. No merge, no decrypt, no LWW.
  module Upsert
    class RevisionConflict < StandardError
      attr_reader :current_revision
      def initialize(current_revision) = (@current_revision = current_revision; super('revision_conflict'))
    end
    module_function
    def call(vault:, item_id:, base_revision:, encrypted_payload:, encrypted_item_key:, encryption_version: 1, device: nil, signature: nil)
      raise ArgumentError, 'encrypted_payload required' if encrypted_payload.blank?
      raise ArgumentError, 'encrypted_item_key required' if encrypted_item_key.blank?
      vault.transaction do
        item = vault.items.lock.find_or_initialize_by(id: item_id)
        if item.persisted? && item.current_revision != base_revision.to_i
          raise RevisionConflict, item.current_revision
        end
        item.current_revision += 1
        item.deleted_at = nil
        item.save!
        # A missing version keeps the column default (1). nil.to_i would
        # persist 0 and fail validation, which rejects clients that omit it.
        resolved_version = encryption_version.nil? ? 1 : encryption_version.to_i
        item.item_versions.create!(revision: item.current_revision, encrypted_payload: encrypted_payload, encrypted_item_key: encrypted_item_key, encryption_version: resolved_version)
        seq = (vault.sync_events.maximum(:sequence) || 0) + 1
        vault.sync_events.create!(sequence: seq, item_id: item.id, revision: item.current_revision, operation: 'upsert', device: device, signature: signature)
        { item_id: item.id, revision: item.current_revision, sequence: seq }
      end
    end
  end
end
