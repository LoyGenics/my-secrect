module Api
  module V1
    # Encrypted items only. Every response field is ciphertext / opaque id.
    # The server never returns (or stores) a title, tag, type or relation.
    #
    # update/destroy go through Sync::Push so sequence assignment takes the
    # same per-vault row lock as POST sync/push. Ciphertext rules are
    # unchanged; a stale base_revision is still 409.
    class ItemsController < ApplicationController
      # GET /v1/vaults/:vault_id/items/:id
      def show
        item = scope.find(params[:id])
        render json: EncryptedRecords::ItemPresenter.call(item: item)
      end

      # PUT /v1/vaults/:vault_id/items/:id — same semantics as sync push:
      # revision-checked, append-only version, 409 on stale base_revision.
      def update
        result = Sync::Push.call(
          vault: vault, item_id: params[:id], base_revision: params[:base_revision],
          operation: 'upsert', encrypted_payload: params[:encrypted_payload],
          encrypted_item_key: params[:encrypted_item_key],
          encryption_version: params[:encryption_version], device: current_device
        )
        render json: result, status: :ok
      rescue Sync::Push::RevisionConflict => e
        render json: { error: 'revision_conflict', current_revision: e.current_revision }, status: :conflict
      rescue ArgumentError => e
        render json: { error: 'invalid_request', message: e.message }, status: :unprocessable_entity
      end

      # DELETE — creates an encrypted tombstone (recoverable), not a hard delete.
      # base_revision must match, same as update. signature is optional
      # opaque bytes forwarded to Sync::Push; it is not authenticated.
      def destroy
        result = Sync::Push.call(
          vault: vault, item_id: params[:id], base_revision: params[:base_revision],
          operation: 'delete', encrypted_payload: nil, encrypted_item_key: nil,
          device: current_device, signature: params[:signature]
        )
        render json: result, status: :ok
      rescue Sync::Push::RevisionConflict => e
        render json: { error: 'revision_conflict', current_revision: e.current_revision }, status: :conflict
      rescue ArgumentError => e
        # Same contract as SyncController#push: invalid signature base64
        # is a request error, not a 500. The signature is not authenticated.
        render json: { error: 'invalid_request', message: e.message }, status: :unprocessable_entity
      end

      private

      def vault = current_user.vaults.find(params[:vault_id])
      def scope = vault.items.where(deleted_at: nil)
    end
  end
end
