module Api
  module V1
    # Account authentication via WebAuthn/passkeys. No password login.
    # Passkey login != vault unlock: a successful login issues a short-lived
    # Bearer session token; the client still needs the master passphrase
    # (or a device-protected key) to unwrap the Account Master Key locally.
    class AuthController < ActionController::API
      # POST /v1/auth/passkeys/register — step 1: creation options + challenge.
      # Body: { email: }. Creates the user if new, stores a one-time challenge.
      def register_passkey
        result = Authentication::Passkeys.registration_options(email: params[:email])
        render json: result, status: :ok
      end

      # POST /v1/auth/passkeys/verify — step 2: verify attestation OR assertion.
      # Body: { email:, credential: {...}, kind: 'registration'|'authentication' }
      # On success returns { token:, user_id:, device_id:, expires_in: }.
      # Challenge is single-use and expires in 5 minutes (anti-replay).
      def verify_passkey
        result = Authentication::Passkeys.verify(
          email: params[:email],
          credential: params[:credential],
          kind: params[:kind] || 'authentication',
          user_agent: request.user_agent
        )
        render json: result, status: :ok
      rescue Authentication::Passkeys::VerificationError => e
        render json: { error: 'verification_failed', detail: e.message }, status: :unauthorized
      end
    end
  end
end
