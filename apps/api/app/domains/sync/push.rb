module Sync
  module Push
    class RevisionConflict < StandardError
      attr_reader :current_revision
      def initialize(current_revision) = (@current_revision = current_revision; super('revision_conflict'))
    end
    module_function
    def call(vault:, item_id:, base_revision:, operation:, encrypted_payload:, encrypted_item_key:, encryption_version: 1, device: nil, signature: nil)
      return EncryptedRecords::Delete.call(vault: vault, item_id: item_id, device: device) if operation == 'delete'
      EncryptedRecords::Upsert.call(vault: vault, item_id: item_id, base_revision: base_revision, encrypted_payload: encrypted_payload, encrypted_item_key: encrypted_item_key, encryption_version: encryption_version, device: device)
    rescue EncryptedRecords::Upsert::RevisionConflict => e
      raise RevisionConflict, e.current_revision
    end
  end
end
