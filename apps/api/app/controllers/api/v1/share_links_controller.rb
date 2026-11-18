module Api
  module V1
    class ShareLinksController < ApplicationController
      # The unguessable id fetches ciphertext only. The fragment key never
      # reaches this controller. Owner listing/creation/revocation require auth.
      skip_before_action :authenticate_request!, only: :show
      before_action :private_response
      rescue_from ArgumentError, with: :invalid_request
      rescue_from ActiveRecord::RecordNotUnique, with: :invalid_request
      def index
        links = ShareLink.where(owner: current_user).order(created_at: :desc).limit(100)
        render json: { links: links.map { |link| present(link, owner: true) } }
      end
      def create
        link = ShareLinks::Create.call(owner: current_user, **params.permit(:id, :format_version, :expires_at, :encrypted_payload, :encrypted_owner_metadata).to_h.symbolize_keys)
        render json: { link: present(link, owner: true) }, status: :created
      end
      def show
        link = ShareLink.available.find(params[:id])
        return head :not_found unless link.available?
        render json: { link: present(link) }
      end
      def destroy
        link = ShareLink.where(owner: current_user).find(params[:id])
        link.update!(revoked_at: Time.current, encrypted_payload: nil, encrypted_owner_metadata: nil)
        head :no_content
      end
      private
      def private_response
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
      end
      def present(link, owner: false)
        result = { id: link.id, format_version: link.format_version, expires_at: link.expires_at.iso8601(3), encrypted_payload: link.encrypted_payload && Base64.strict_encode64(link.encrypted_payload) }
        return result unless owner
        result.merge(encrypted_owner_metadata: link.encrypted_owner_metadata && Base64.strict_encode64(link.encrypted_owner_metadata), revoked_at: link.revoked_at&.iso8601(3), created_at: link.created_at.iso8601(3))
      end
      def invalid_request = render json: { error: 'invalid_share_link' }, status: :unprocessable_entity
    end
  end
end
