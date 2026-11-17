module EncryptedRecords
  # Append-only, revision-checked upsert. No merge, no decrypt, no LWW.
  # Rules (specs/sync-protocol.md, "Server rules"):
  #  - base_revision must equal the item's current_revision; a new item is
  #    pushed with base 0 (nil counts as 0). Anything else — behind (stale)
  #    or ahead (a revision this server never issued) — raises
  #    RevisionConflict (409 with current_revision) and writes nothing.
  #  - Replay: if the version at base_revision + 1 already holds exactly
  #    these bytes (payload, wrapped item key, encryption_version), this
  #    push was accepted before and its response was lost. Nothing is
  #    written; the original revision and sequence come back with
  #    replayed: true, even when later revisions exist.
  #  - Rollback: a payload byte-identical to a stored version of this item
  #    is refused (CiphertextReuse), so someone who cannot encrypt (e.g. a
  #    stolen session without the vault key) cannot re-push old ciphertext
  #    as a new revision. One exception: restoring a tombstoned item with
  #    the ciphertext of its newest version, i.e. exactly what was deleted.
  #    Writing older content again means re-encrypting it (fresh nonce).
  #  - An item id that already belongs to another vault is refused.
  # Lock order: vault row, then item row; AppendEvent allocates the sequence.
  module Upsert
    class RevisionConflict < StandardError
      attr_reader :current_revision
      def initialize(current_revision) = (@current_revision = current_revision; super('revision_conflict'))
    end

    class CiphertextReuse < StandardError
      attr_reader :revision
      def initialize(revision) = (@revision = revision; super('ciphertext_reuse'))
    end

    module_function

    def call(vault:, item_id:, base_revision:, encrypted_payload:, encrypted_item_key:, encryption_version: 1, device: nil, signature: nil)
      raise ArgumentError, 'encrypted_payload required' if encrypted_payload.blank?
      raise ArgumentError, 'encrypted_item_key required' if encrypted_item_key.blank?
      base = base_revision.to_i
      # A missing version keeps the column default (1). nil.to_i would
      # persist 0 and fail validation, which rejects clients that omit it.
      version = encryption_version.nil? ? 1 : encryption_version.to_i
      vault.transaction do
        vault.lock!
        item = vault.items.lock.find_by(id: item_id)
        replay = item && replayed_write(item, base, encrypted_payload, encrypted_item_key, version)
        if replay
          replay
        else
          item ||= new_item(vault, item_id)
          raise RevisionConflict, item.current_revision unless item.current_revision == base
          refuse_reused_ciphertext!(item, encrypted_payload) if item.persisted?
          item.current_revision += 1
          item.deleted_at = nil
          item.save!
          item.item_versions.create!(revision: item.current_revision, encrypted_payload: encrypted_payload, encrypted_item_key: encrypted_item_key, encryption_version: version)
          event = AppendEvent.call(vault: vault, item: item, operation: 'upsert', device: device, signature: signature)
          { item_id: item.id, revision: item.current_revision, sequence: event.sequence }
        end
      end
    end

    def new_item(vault, item_id)
      raise ArgumentError, 'item_id is already used by another vault' if Item.exists?(id: item_id)
      vault.items.new(id: item_id)
    end

    def replayed_write(item, base, payload, item_key, version)
      stored = item.item_versions.find_by(revision: base + 1)
      return nil unless stored && stored.encryption_version == version
      return nil unless stored.encrypted_payload.b == payload.b && stored.encrypted_item_key.b == item_key.b
      event = item.sync_events.find_by!(revision: stored.revision)
      { item_id: item.id, revision: stored.revision, sequence: event.sequence, replayed: true }
    end

    def refuse_reused_ciphertext!(item, payload)
      reused = item.item_versions.where(encrypted_payload: payload).maximum(:revision)
      return unless reused
      return if item.deleted? && reused == item.item_versions.maximum(:revision)
      raise CiphertextReuse, reused
    end
  end
end
