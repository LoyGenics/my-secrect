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
    #
    # `signature` is optional client-supplied opaque bytes (standard
    # base64 on the wire). It is stored on the sync event and echoed
    # on pull. It is not authenticated: no device-signature algorithm
    # is agreed, so a missing signature is accepted. Invalid base64
    # raises ArgumentError (the controller turns that into 422).
    def call(vault:, item_id:, base_revision:, operation:, encrypted_payload:, encrypted_item_key:, encryption_version: 1, device: nil, signature: nil)
      raise ArgumentError, 'operation must be upsert or delete' unless %w[upsert delete].include?(operation.to_s)
      if operation.to_s == 'upsert'
        raise ArgumentError, 'encrypted_payload required' if encrypted_payload.blank?
        raise ArgumentError, 'encrypted_item_key required' if encrypted_item_key.blank?
      end
      signature_bytes = decode_opaque_signature(signature)
      # Wire format: standard base64. Stored: the DECODED ciphertext bytes
      # (Pull and ItemPresenter re-encode exactly once). Before this fix the
      # base64 TEXT was stored as the bytes and pull base64'd it again, so
      # every client received double-encoded ciphertext it could not open.
      if operation.to_s == 'upsert'
        encrypted_payload = decode_ciphertext(encrypted_payload, 'encrypted_payload')
        encrypted_item_key = decode_ciphertext(encrypted_item_key, 'encrypted_item_key')
      end
      attempts = 0
      begin
        vault.with_lock do
          if operation.to_s == 'delete'
            EncryptedRecords::Delete.call(vault: vault, item_id: item_id, base_revision: base_revision, device: device, signature: signature_bytes)
          else
            EncryptedRecords::Upsert.call(
              vault: vault, item_id: item_id, base_revision: base_revision,
              encrypted_payload: encrypted_payload, encrypted_item_key: encrypted_item_key,
              encryption_version: encryption_version, device: device, signature: signature_bytes
            )
          end
        end
      rescue ActiveRecord::RecordNotUnique
        attempts += 1
        retry if attempts < 2
        raise
      end
    rescue EncryptedRecords::Upsert::RevisionConflict => e
      raise RevisionConflict, e.current_revision
    end

    def decode_ciphertext(value, name)
      raise ArgumentError, "#{name} must be a base64 string" unless value.is_a?(String)
      Base64.strict_decode64(value)
    rescue ArgumentError
      raise ArgumentError, "#{name} must be standard base64"
    end

    # nil / "" means the client omitted a signature. Anything else must
    # be standard base64. The decoded bytes are stored unchanged.
    def decode_opaque_signature(signature)
      return nil if signature.nil?
      raise ArgumentError, 'invalid signature encoding' unless signature.is_a?(String)
      return nil if signature.empty?
      Base64.strict_decode64(signature)
    rescue ArgumentError
      raise ArgumentError, 'invalid signature encoding'
    end
  end
end
