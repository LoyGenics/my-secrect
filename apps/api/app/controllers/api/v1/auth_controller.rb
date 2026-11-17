module Api
  module V1
    # Account authentication via WebAuthn/passkeys + MFA + step-up.
    # No password login. Passkey login != vault unlock: a successful
    # login issues a short-lived Bearer session token; the client still
    # needs the master passphrase (or a device-protected key) to unwrap
    # the Account Master Key locally.
    class AuthController < ApplicationController
      skip_before_action :authenticate_request!, only: %i[register_passkey verify_passkey authenticate_passkey verify_mfa]

      # POST /v1/auth/passkeys/register — step 1: creation options + challenge.
      # Body: { email: }. Creates the user if new, stores a one-time challenge.
      def register_passkey
        result = Authentication::Passkeys.registration_options(email: params[:email])
        render json: result, status: :ok
      end

      # POST /v1/auth/passkeys/verify — step 2: verify attestation OR assertion.
      # Body: { email:, credential: {...}, kind: 'registration'|'authentication' }
      # On success returns { token:, user_id:, device_id:, expires_in: } —
      # or, when the user has MFA enabled and kind is 'authentication',
      # { mfa_required: true, mfa_token:, user_id: } and NO session yet.
      # Challenge is single-use and expires in 5 minutes (anti-replay).
      def verify_passkey
        result = Authentication::Passkeys.verify(
          email: params[:email],
          credential: params[:credential],
          kind: params[:kind] || 'authentication',
          user_agent: request.user_agent,
          ip_address: request.remote_ip
        )
        render json: result, status: :ok
      rescue Authentication::Passkeys::VerificationError => e
        render json: { error: 'verification_failed', detail: e.message }, status: :unauthorized
      end

      # POST /v1/auth/passkeys/authenticate — step 1 (login): request
      # options + stored challenge. Body: { email: }. Unknown emails get
      # an empty allow-list so the response does not leak existence.
      def authenticate_passkey
        result = Authentication::Passkeys.authentication_options(email: params[:email])
        render json: result, status: :ok
      end

      # POST /v1/auth/mfa/verify — step 2 of an MFA login.
      # Body: { mfa_token:, code: } where code is a TOTP code or a
      # recovery code. The mfa_token is single-use (5 min); on success a
      # full session is issued. Rate-limited (rack_attack).
      def verify_mfa
        result = Authentication::Totp.complete_mfa_login(
          mfa_token: params[:mfa_token], code: params[:code],
          user_agent: request.user_agent, ip_address: request.remote_ip
        )
        render json: result, status: :ok
      rescue Authentication::Totp::VerificationError
        render json: { error: 'verification_failed' }, status: :unauthorized
      end

      # POST /v1/auth/step-up/totp — verify a TOTP code (or recovery code)
      # as a step-up for the current session. Body: { code: }.
      def step_up_totp
        factor = Authentication::Totp.verify_second_factor(user: current_user, code: params[:code])
        unless factor
          Audit::Log.call(user: current_user, device: current_device,
                          event_type: 'step_up_failed', metadata: { method: 'totp' })
          render json: { error: 'verification_failed' }, status: :unauthorized and return
        end
        method = factor == :recovery_code ? 'recovery_code' : 'totp'
        Authentication::StepUp.mark_verified!(current_session, method: method)
        render json: { step_up_verified: true, method: method,
                       verified_until: Authentication::StepUp::WINDOW.from_now }, status: :ok
      end

      # POST /v1/auth/step-up/passkey/options — request options for a
      # passkey step-up (same challenge flow as login).
      def step_up_passkey_options
        result = Authentication::Passkeys.authentication_options(email: current_user.email)
        render json: result, status: :ok
      end

      # POST /v1/auth/step-up/passkey — verify a passkey assertion as a
      # step-up for the current session. Body: { credential: {...} }.
      # Marks the session verified; issues NO new session token.
      def step_up_passkey
        Authentication::StepUp.verify_passkey(user: current_user, credential: params[:credential], session: current_session)
        render json: { step_up_verified: true, method: 'passkey',
                       verified_until: Authentication::StepUp::WINDOW.from_now }, status: :ok
      rescue Authentication::StepUp::VerificationError
        Audit::Log.call(user: current_user, device: current_device,
                        event_type: 'step_up_failed', metadata: { method: 'passkey' })
        render json: { error: 'verification_failed' }, status: :unauthorized
      end

      # GET /v1/auth/activity — the user's audit events, newest first,
      # at most 50. Body: { events: [{ event_type:, device_id:, created_at:, metadata: }] }.
      def activity
        limit = [[params[:limit].to_i, 1].max, 50].min
        limit = 50 if params[:limit].blank?
        events = current_user.audit_events.order(created_at: :desc).limit(limit)
        render json: { events: events.as_json(only: %i[event_type device_id created_at metadata]) }, status: :ok
      end
    end
  end
end
