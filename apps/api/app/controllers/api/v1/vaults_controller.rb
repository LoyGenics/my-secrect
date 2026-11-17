module Api
  module V1
    class VaultsController < ApplicationController
      def index
        render json: { vaults: current_user.vaults.as_json(only: %i[id key_version created_at]) }
      end

      # POST /v1/vaults — body: { encrypted_metadata: base64, key_envelopes: [{recipient_id:, encrypted_key:}] }
      # Server stores the envelopes opaquely; it cannot read the wrapped keys.
      def create
        vault = Vaults::Create.call(owner: current_user, encrypted_metadata: params[:encrypted_metadata], key_envelopes: params[:key_envelopes] || [])
        render json: { vault: vault.as_json(only: %i[id key_version created_at]) }, status: :created
      end

      def show
        vault = current_user.vaults.find(params[:id])
        render json: { vault: vault.as_json(only: %i[id key_version created_at]) }
      end

      # GET /v1/vaults/:id/key-envelopes — envelopes addressed to the current user/device.
      def key_envelopes
        vault = current_user.vaults.find(params[:id])
        envelopes = vault.key_envelopes.where(recipient_id: [current_user.id, current_device&.id].compact)
        render json: { key_envelopes: envelopes.as_json(only: %i[id recipient_id key_version encrypted_key]) }
      end
    end
  end
end
