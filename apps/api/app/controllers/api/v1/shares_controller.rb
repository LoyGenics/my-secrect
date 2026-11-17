module Api
  module V1
    # Sharing is Phase 5, after personal key management is stable.
    # This controller + Sharing domain define the contract now: a share is
    # a vault key envelope for a recipient + a permission, nothing more.
    # The server cannot read shared content either.
    class SharesController < ApplicationController
      def create
        share = Sharing::Create.call(owner: current_user, vault_id: params[:vault_id], recipient_email: params[:recipient_email], permission: params[:permission] || 'read', encrypted_key: params[:encrypted_key])
        render json: { share: share.as_json(only: %i[id vault_id recipient_id permission status]) }, status: :created
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
