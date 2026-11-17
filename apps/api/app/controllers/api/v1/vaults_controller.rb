module Api
  module V1
    class VaultsController < ApplicationController
      include ActiveDeviceRequired

      # encrypted_metadata is ciphertext under the Vault Key (clients write it with
      # encryptWithVaultKey), returned exactly as the client sent it. A device that
      # cannot open it holds a different Vault Key and must not sync into this vault
      # (apps/desktop/src/sync/engine.ts checks this before its first push).
      def index
        render json: { vaults: current_user.vaults.map { |vault| vault_json(vault) } }
      end

      # POST /v1/vaults — body: { encrypted_metadata: base64, key_envelopes: [{recipient_id:, encrypted_key:}] }
      # Server stores the envelopes opaquely; it cannot read the wrapped keys.
      def create
        vault = Vaults::Create.call(owner: current_user, encrypted_metadata: params[:encrypted_metadata], key_envelopes: params[:key_envelopes] || [])
        render json: { vault: vault_json(vault) }, status: :created
      end

      def show
        vault = current_user.vaults.find(params[:id])
        render json: { vault: vault_json(vault) }
      end

      # GET /v1/vaults/:id/key-envelopes — envelopes addressed to the current user/device.
      def key_envelopes
        vault = current_user.vaults.find(params[:id])
        envelopes = vault.key_envelopes.where(recipient_id: [current_user.id, current_device&.id].compact)
        render json: { key_envelopes: envelopes.as_json(only: %i[id recipient_id key_version encrypted_key]) }
      end

      private

      # Stored as the base64 text the client posted; anything that is not valid
      # base64 text cannot be a key check and is returned as nil.
      def vault_json(vault)
        text = vault.encrypted_metadata&.dup&.force_encoding(Encoding::UTF_8)
        key_check = text if text&.valid_encoding? && text.match?(%r{\A[A-Za-z0-9+/]+={0,2}\z})
        vault.as_json(only: %i[id key_version created_at]).merge('encrypted_metadata' => key_check)
      end
    end
  end
end
