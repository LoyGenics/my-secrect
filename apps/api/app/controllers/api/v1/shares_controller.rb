module Api
  module V1
    # Sharing is Phase 5, after personal key management is stable.
    # This controller + Sharing domain define the contract now: a share is
    # a vault key envelope for a recipient + a permission, nothing more.
    # The server cannot read shared content either.
    class SharesController < ApplicationController
      # Persists a pending share only. ArgumentError (blank key, unknown
      # recipient, self-share, bad permission) is a client error — return
      # the message as 422 JSON. Do not drop it.
      def create
        share = Sharing::Create.call(owner: current_user, vault_id: params[:vault_id], recipient_email: params[:recipient_email], permission: params[:permission] || 'read', encrypted_key: params[:encrypted_key])
        render json: { share: share.as_json(only: %i[id vault_id recipient_id permission status]) }, status: :created
      rescue ArgumentError => e
        render json: { error: 'invalid_request', message: e.message }, status: :unprocessable_entity
      end

      def destroy
        # Only the owner who created the share can revoke it.
        share = current_user.owned_shares.find(params[:id])
        Sharing::Revoke.call(share: share)
        head :no_content
      end
    end
  end
end
