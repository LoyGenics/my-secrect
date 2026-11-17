module Api
  module V1
    # Sync is append-only + optimistic concurrency. The server validates
    # versions and appends — it NEVER decrypts, merges, or last-write-wins.
    # Conflicts are detected here (base_revision mismatch) and resolved
    # on the CLIENT after decryption (see packages/sync).
    #
    # Pull (Phase C, H1): each upsert event carries encrypted_payload +
    # encrypted_item_key (+ encryption_version) at the event revision, so
    # the client can verify + apply it. Delete events carry tombstone: true
    # and no ciphertext. Responses contain ciphertext + opaque ids only —
    # never plaintext titles/tags/types/relations.
    class SyncController < ApplicationController
      include ActiveDeviceRequired

      # GET /v1/vaults/:vault_id/sync?since=cursor
      def pull
        vault = current_user.vaults.find(params[:vault_id])
        events = Sync::Pull.call(vault: vault, since: params[:since])
        render json: events
      end

      # POST /v1/vaults/:vault_id/sync/push
      # 200 { item_id, revision, sequence } — plus replayed: true when this
      # exact write was already accepted (nothing appended). 409 when
      # base_revision is not the current revision. 422 for invalid input and
      # for a payload that repeats an older version (ciphertext_reuse).
      # Optional `signature` is opaque base64 stored on the event. It is
      # not authenticated; omitting it is allowed. Invalid base64 is 422.
      def push
        vault = current_user.vaults.find(params[:vault_id])
        result = Sync::Push.call(
          vault: vault, item_id: params[:item_id], base_revision: params[:base_revision],
          operation: params[:operation] || 'upsert', encrypted_payload: params[:encrypted_payload],
          encrypted_item_key: params[:encrypted_item_key], encryption_version: params[:encryption_version],
          device: current_device, signature: params[:signature]
        )
        render json: result, status: :ok
      rescue Sync::Push::RevisionConflict => e
        render json: { error: 'revision_conflict', current_revision: e.current_revision }, status: :conflict
      rescue Sync::Push::CiphertextReuse => e
        render json: { error: 'ciphertext_reuse', revision: e.revision }, status: :unprocessable_entity
      rescue ArgumentError => e
        # Missing ciphertext / bad operation: a client bug, not a server
        # error. 422 (not 500) so clients can surface it as a request error.
        render json: { error: 'invalid_request', message: e.message }, status: :unprocessable_entity
      end
    end
  end
end
