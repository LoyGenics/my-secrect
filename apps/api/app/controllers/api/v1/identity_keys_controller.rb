module Api
  module V1
    # Sharing identity keys (specs/sharing-protocol.md §3–4). The server
    # stores the public key and an opaque Vault-Key ciphertext of the secret
    # key; it can decrypt neither. Lookup returns PUBLIC keys only — the
    # caller must verify the fingerprint out of band before trusting one.
    class IdentityKeysController < ApplicationController
      rescue_from Sharing::Failure, with: :render_sharing_failure

      # GET /v1/identity-key — the caller's own key (for their other devices).
      def show
        key = IdentityKey.find_by!(user_id: current_user.id)
        render json: { identity_key: own_key_json(key) }
      end

      # PUT /v1/identity-key — write-once registration.
      def update
        key, created = Sharing::RegisterIdentityKey.call(
          user: current_user, public_key: params[:public_key], encrypted_secret_key: params[:encrypted_secret_key]
        )
        render json: { identity_key: own_key_json(key) }, status: created ? :created : :ok
      end

      # POST /v1/identity-keys/lookup { email } — email in the body, not the URL.
      def lookup
        user = User.find_by!(email: params[:email].to_s.strip.downcase, status: 'active')
        key = IdentityKey.find_by!(user_id: user.id)
        render json: { user_id: user.id, email: user.email, public_key: Sharing::Wire.encode(key.public_key) }
      end

      private

      def own_key_json(key)
        {
          user_id: key.user_id,
          public_key: Sharing::Wire.encode(key.public_key),
          encrypted_secret_key: Sharing::Wire.encode(key.encrypted_secret_key),
          created_at: key.created_at
        }
      end

      def render_sharing_failure(error)
        render json: { error: error.code, message: error.message, **error.details }, status: error.status
      end
    end
  end
end
