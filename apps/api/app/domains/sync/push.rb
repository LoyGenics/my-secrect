module Sync
  module Push
    class RevisionConflict < StandardError
      attr_reader :current_revision
      def initialize(current_revision) = (@current_revision = current_revision; super('revision_conflict'))
    end
    # The payload repeats a stored version of the item (rollback attempt).
    class CiphertextReuse < StandardError
      attr_reader :revision
      def initialize(revision) = (@revision = revision; super('ciphertext_reuse'))
    end
    UUID_FORMAT = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/
    module_function
    # Sequence allocation: EncryptedRecords::Upsert / ::Delete lock the
    # vault row before touching the item and EncryptedRecords::AppendEvent
    # allocates max(sequence) + 1 under that lock, so pushes to one vault
    # are serialised and sequences are unique and gap-free whoever calls
    # them (see spec/domains/sync_sequence_concurrency_spec.rb).
    # The server still NEVER decrypts, merges, or last-write-wins:
    # a base_revision other than the current one raises RevisionConflict
    # (409) and the client resolves it after decryption (see packages/sync).
    # Replays of an accepted write return it again (replayed: true) and a
    # payload that repeats an older version raises CiphertextReuse (422):
    # see EncryptedRecords::Upsert / ::Delete for the exact rules.
    #
    # `signature` is optional client-supplied opaque bytes (standard
    # base64 on the wire). It is stored on the sync event and echoed
    # on pull. It is not authenticated: no device-signature algorithm
    # is agreed, so a missing signature is accepted. Invalid base64
    # raises ArgumentError (the controller turns that into 422).
    def call(vault:, item_id:, base_revision:, operation:, encrypted_payload:, encrypted_item_key:, encryption_version: 1, device: nil, signature: nil)
      raise ArgumentError, 'operation must be upsert or delete' unless %w[upsert delete].include?(operation.to_s)
      # items.id is a uuid column: an invalid id used to cast to nil and the
      # server silently minted a DIFFERENT id, so the pushed item never
      # appeared under the id the client used. Reject it instead.
      unless item_id.is_a?(String) && item_id.match?(UUID_FORMAT)
        raise ArgumentError, 'item_id must be a lowercase uuid'
      end
      if operation.to_s == 'upsert'
        raise ArgumentError, 'encrypted_payload required' if encrypted_payload.blank?
        raise ArgumentError, 'encrypted_item_key required' if encrypted_item_key.blank?
      end
      base_revision = parse_base_revision(base_revision)
      signature_bytes = decode_opaque_signature(signature)
      # Wire format: standard base64. Stored: the DECODED ciphertext bytes
      # (Pull and ItemPresenter re-encode exactly once). Before this fix the
      # base64 TEXT was stored as the bytes and pull base64'd it again, so
      # every client received double-encoded ciphertext it could not open.
      if operation.to_s == 'upsert'
        encrypted_payload = decode_ciphertext(encrypted_payload, 'encrypted_payload')
        encrypted_item_key = decode_ciphertext(encrypted_item_key, 'encrypted_item_key')
      end
      if operation.to_s == 'delete'
        EncryptedRecords::Delete.call(vault: vault, item_id: item_id, base_revision: base_revision, device: device, signature: signature_bytes)
      else
        EncryptedRecords::Upsert.call(
          vault: vault, item_id: item_id, base_revision: base_revision,
          encrypted_payload: encrypted_payload, encrypted_item_key: encrypted_item_key,
          encryption_version: encryption_version, device: device, signature: signature_bytes
        )
      end
    rescue EncryptedRecords::Upsert::RevisionConflict => e
      raise RevisionConflict, e.current_revision
    rescue EncryptedRecords::Upsert::CiphertextReuse => e
      raise CiphertextReuse, e.revision
    end

    # A non-negative integer: a JSON number, or a string of digits (form
    # params). Missing stays nil (an upsert treats it as 0, a delete
    # refuses it). Anything else is a client bug — "2x".to_i would silently
    # become 2 — so it is a 422, not a guess.
    def parse_base_revision(value)
      return nil if value.nil? || value == ''
      return value if value.is_a?(Integer) && !value.negative?
      return value.to_i if value.is_a?(String) && value.match?(/\A\d+\z/)
      raise ArgumentError, 'base_revision must be a non-negative integer'
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
