module EncryptedRecords
  # The ONLY shape the API ever returns for an item: opaque ids + ciphertext.
  # If a field here ever contained a title/tag/type in plaintext, that is a bug.
  module ItemPresenter
    module_function
    def call(item:)
      version = item.current_version
      {
        item: {
          id: item.id, vault_id: item.vault_id, current_revision: item.current_revision,
          deleted_at: item.deleted_at,
          current_version: version ? {
            revision: version.revision,
            encrypted_payload: version.encrypted_payload,
            encrypted_item_key: version.encrypted_item_key,
            encryption_version: version.encryption_version
          } : nil
        }
      }
    end
  end
end
