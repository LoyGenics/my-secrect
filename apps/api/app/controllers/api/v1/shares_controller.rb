module Api
  module V1
    # End-to-end encrypted item shares (specs/sharing-protocol.md). Every
    # share is looked up within the caller's own shares (owner or
    # recipient), so anyone else gets 404. Permission, expiry and
    # revocation are enforced in the Sharing domain (403 / 409 / 422).
    class SharesController < ApplicationController
      rescue_from Sharing::Failure, with: :render_sharing_failure

      def index
        shares = ItemShare.for_party(current_user).includes(:owner, :recipient).order(created_at: :desc)
        render json: { shares: shares.map { |share| Sharing::Presenter.share(share, viewer: current_user) } }
      end

      def create
        share = Sharing::Create.call(
          owner: current_user, id: params[:id], recipient_id: params[:recipient_id],
          recipient_public_key: params[:recipient_public_key], permission: params[:permission],
          expires_at: params[:expires_at], encrypted_payload: params[:encrypted_payload],
          encrypted_item_key: params[:encrypted_item_key], encrypted_owner_metadata: params[:encrypted_owner_metadata]
        )
        render json: { share: Sharing::Presenter.share(share, viewer: current_user) }, status: :created
      end

      # GET /v1/shares/:id/record
      def record
        render json: { record: Sharing::ReadRecord.call(share: find_share, user: current_user) }
      end

      # PUT /v1/shares/:id/record
      def write_record
        record = Sharing::WriteRecord.call(
          share: find_share, user: current_user, base_revision: params[:base_revision],
          encrypted_payload: params[:encrypted_payload], encrypted_item_key: params[:encrypted_item_key]
        )
        render json: { record: record }
      end

      # POST /v1/shares/:id/accept
      def accept
        share = Sharing::Accept.call(share: find_share, user: current_user, owner_public_key: params[:owner_public_key])
        render json: { share: Sharing::Presenter.share(share, viewer: current_user) }
      end

      # DELETE /v1/shares/:id — owner revokes; recipient declines or leaves.
      def destroy
        Sharing::Revoke.call(share: find_share, user: current_user)
        head :no_content
      end

      private

      def find_share = ItemShare.for_party(current_user).find(params[:id])

      def render_sharing_failure(error)
        render json: { error: error.code, message: error.message, **error.details }, status: error.status
      end
    end
  end
end
