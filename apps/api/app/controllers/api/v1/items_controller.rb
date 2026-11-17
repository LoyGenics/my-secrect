module Api
  module V1
    # Encrypted items only. Every response field is ciphertext / opaque id.
    # The server never returns (or stores) a title, tag, type or relation.
    class ItemsController < ApplicationController
      # GET /v1/vaults/:vault_id/items/:id
      def show
        item = scope.find(params[:id])
        render json: EncryptedRecords::ItemPresenter.call(item: item)
      end

      # PUT /v1/vaults/:vault_id/items/:id — same semantics as sync push:
      # revision-checked, append-only version, 409 on stale base_revision.
      def update
        result = EncryptedRecords::Upsert.call(
          vault: vault, item_id: params[:id], base_revision: params[:base_revision],
          encrypted_payload: params[:encrypted_payload], encrypted_item_key: params[:encrypted_item_key],
          encryption_version: params[:encryption_version], device: current_device
        )
        render json: result, status: :ok
      rescue EncryptedRecords::Upsert::RevisionConflict => e
        render json: { error: 'revision_conflict', current_revision: e.current_revision }, status: :conflict
      end

      # DELETE — creates an encrypted tombstone (recoverable), not a hard delete.
      def destroy
        result = EncryptedRecords::Delete.call(vault: vault, item_id: params[:id], device: current_device)
        render json: result, status: :ok
      end

      private

      def vault = current_user.vaults.find(params[:vault_id])
      def scope = vault.items.where(deleted_at: nil)
    end
  end
end
