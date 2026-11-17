module Api
  module V1
    # Authenticated passkey management. Listing is read-only; adding and
    # removing a passkey both require step-up and rotate the session
    # token (a token stolen before the change stops working).
    class PasskeysController < ApplicationController
      # GET /v1/auth/passkeys — all authenticators (active + revoked),
      # newest first. Only a credential_id prefix is exposed, never the
      # full id or the public key.
      def index
        authenticators = current_user.authenticators.order(created_at: :desc)
        render json: { passkeys: authenticators.map { |a| passkey_json(a) } }, status: :ok
      end

      # POST /v1/auth/passkeys/add/options — creation options for an
      # additional passkey. Step-up required. No user is created here;
      # the challenge is stored under the session user's own email.
      def add_options
        require_step_up!
        result = Authentication::Passkeys.add_registration_options(user: current_user)
        render json: result, status: :ok
      end

      # POST /v1/auth/passkeys/add/verify — verify the attestation and
      # bind it to the authenticated user. Step-up required. Body:
      # { credential: {...} }. Returns the new passkey + rotated_token.
      def add_verify
        require_step_up!
        authenticator = Authentication::Passkeys.verify_addition(user: current_user, credential: params[:credential])
        Audit::Log.call(user: current_user, device: current_device, event_type: 'passkey_added')
        render json: { passkey: passkey_json(authenticator), rotated_token: rotate_current_session! }, status: :created
      rescue Authentication::Passkeys::VerificationError => e
        render json: { error: 'verification_failed', detail: e.message }, status: :unauthorized
      end

      # DELETE /v1/auth/passkeys/:id — revoke an authenticator. Step-up
      # required. Refused with 422 when it is the user's last active
      # authenticator AND MFA is not enabled (account lockout protection:
      # the user would have no way back in). Returns rotated_token.
      def destroy
        require_step_up!
        authenticator = current_user.authenticators.find(params[:id])
        if current_user.authenticators.active.count <= 1 && !current_user.mfa_enabled?
          render json: { error: 'last_authenticator',
                         detail: 'cannot remove the last passkey while MFA is disabled' },
                 status: :unprocessable_entity and return
        end
        authenticator.update!(revoked_at: Time.current)
        Audit::Log.call(user: current_user, device: current_device, event_type: 'passkey_removed')
        render json: { revoked: true, rotated_token: rotate_current_session! }, status: :ok
      end

      private

      def passkey_json(authenticator)
        {
          id: authenticator.id,
          credential_id_prefix: authenticator.credential_id.to_s[0, 12],
          created_at: authenticator.created_at,
          sign_count: authenticator.sign_count,
          revoked_at: authenticator.revoked_at
        }
      end
    end
  end
end
