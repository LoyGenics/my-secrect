module Api
  module V1
    # Sync is append-only + optimistic concurrency. The server validates
    # versions and appends — it NEVER decrypts, merges, or last-write-wins.
    # Conflicts are detected here (base_revision mismatch) and resolved
    # on the CLIENT after decryption (see packages/sync).
    class SyncController < ApplicationController
      # GET /v1/vaults/:vault_id/sync?since=cursor
      def pull
        vault = current_user.vaults.find(params[:vault_id])
        events = Sync::Pull.call(vault: vault, since: params[:since])
        render json: events
      end

      # POST /v1/vaults/:vault_id/sync/push
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
      end
    end
  end
end
