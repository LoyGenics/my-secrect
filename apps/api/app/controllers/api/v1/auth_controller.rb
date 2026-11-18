module Api
  module V1
    # Account authentication via WebAuthn/passkeys + MFA + step-up.
    # No password login. Passkey login != vault unlock: a successful
    # login issues a short-lived Bearer session token; the client still
    # needs the master passphrase (or a device-protected key) to unwrap
    # the Account Master Key locally.
    class AuthController < ApplicationController
      skip_before_action :authenticate_request!,
                         only: %i[request_email_code verify_email_code email_session register_passkey verify_passkey
                                  authenticate_passkey verify_mfa]

      # POST /v1/auth/email/request — sign-up step 1: email a 6-digit code.
      # Body: { email: }. 202 { status: 'sent', expires_in: 600 } for EVERY
      # valid address, whether or not it already has an account (an
      # existing owner is emailed a notice instead of a code). 422 for a
      # malformed address, 503 when mail cannot be sent. Rate-limited.
      def request_email_code
        result = Authentication::EmailOwnership.request_code(email: params[:email])
        render json: result, status: :accepted
      rescue Authentication::EmailOwnership::InvalidEmail
        render json: { error: 'invalid_email' }, status: :unprocessable_entity
      rescue Authentication::EmailOwnership::DeliveryError
        render json: { error: 'email_unavailable' }, status: :service_unavailable
      end

      # POST /v1/auth/email/verify — sign-up step 2. Body: { email:, code: }.
      # 200 { registration_ticket:, expires_in: 600 } (ticket shown once),
      # or one generic 401 for every failure. 5 attempts per code, then
      # the code is burned. Rate-limited.
      def verify_email_code
        result = Authentication::EmailOwnership.verify_code(email: params[:email], code: params[:code])
        render json: result, status: :ok
      rescue Authentication::EmailOwnership::VerificationError
        render json: { error: 'verification_failed' }, status: :unauthorized
      end

      # POST /v1/auth/email/session — sign in (or sign up) with the email
      # alone, for an account without a passkey. Body: { email:,
      # registration_ticket:, device: (optional, same proof as the passkey
      # verify, signed over the ticket) }. Returns { token:, user_id:,
      # device_id:, expires_in: } or { mfa_required: true, mfa_token:, user_id: }.
      # One generic 401 verification_failed; 401 device_verification_failed
      # for a bad device proof (the ticket stays usable).
      def email_session
        result = Authentication::EmailSignIn.call(
          email: params[:email], registration_ticket: params[:registration_ticket], device: params[:device],
          user_agent: request.user_agent, ip_address: request.remote_ip
        )
        render json: result, status: :ok
      rescue Authentication::EmailOwnership::VerificationError
        render json: { error: 'verification_failed' }, status: :unauthorized
      rescue Authentication::DeviceProof::VerificationError
        render json: { error: 'device_verification_failed' }, status: :unauthorized
      end

      # POST /v1/auth/passkeys/register — sign-up step 3: creation options
      # + challenge. Body: { email:, registration_ticket: }. Requires the
      # live ticket from /auth/email/verify; creates NO user row (the
      # registration verify does). Generic 401 for a bad ticket.
      def register_passkey
        result = Authentication::Passkeys.registration_options(
          email: params[:email], registration_ticket: params[:registration_ticket]
        )
        render json: result, status: :ok
      rescue Authentication::Passkeys::VerificationError
        render json: { error: 'verification_failed' }, status: :unauthorized
      end

      # POST /v1/auth/passkeys/verify — step 2: verify attestation OR assertion.
      # Body: { email:, credential: {...}, kind: 'registration'|'authentication',
      #         device: (optional) { public_key:, signature:, platform:, name_encrypted: }
      #                          | { id:, signature: } }
      # `device` is a device proof over this ceremony's challenge
      # (specs/device-identity.md §6.1); without it the session is unbound
      # (device_id null). On success returns { token:, user_id:, device_id:,
      # expires_in: } — or, when the user has MFA enabled and kind is
      # 'authentication', { mfa_required: true, mfa_token:, user_id: } and
      # NO session yet. Challenge is single-use and expires in 5 minutes.
      # A verified passkey with a bad device proof answers 401
      # device_verification_failed (the client drops its local device key).
      def verify_passkey
        result = Authentication::Passkeys.verify(
          email: params[:email],
          credential: params[:credential],
          kind: params[:kind] || 'authentication',
          device: params[:device],
          user_agent: request.user_agent,
          ip_address: request.remote_ip
        )
        render json: result, status: :ok
      rescue Authentication::Passkeys::DeviceApprovalRequired
        # The passkey enrolled a since-revoked device: it may only bind an
        # active device until re-approved (specs/device-identity.md §6.3).
        render json: { error: 'device_approval_required' }, status: :forbidden
      rescue Authentication::Passkeys::DeviceVerificationError
        render json: { error: 'device_verification_failed' }, status: :unauthorized
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

      # POST /v1/auth/step-up/email/request — mail a step-up code to the
      # signed-in account. 403 email_step_up_unavailable once the account has
      # a passkey or MFA (use those instead).
      def step_up_email_request
        render json: Authentication::StepUp.request_email_code(user: current_user), status: :accepted
      rescue Authentication::StepUp::VerificationError
        render json: { error: 'email_step_up_unavailable' }, status: :forbidden
      rescue Authentication::EmailOwnership::DeliveryError
        render json: { error: 'email_unavailable' }, status: :service_unavailable
      end

      # POST /v1/auth/step-up/email — verify that code as a step-up for the
      # current session. Body: { code: }.
      def step_up_email
        Authentication::StepUp.verify_email(user: current_user, code: params[:code], session: current_session)
        render json: { step_up_verified: true, method: 'email',
                       verified_until: Authentication::StepUp::WINDOW.from_now }, status: :ok
      rescue Authentication::StepUp::VerificationError
        Audit::Log.call(user: current_user, device: current_device,
                        event_type: 'step_up_failed', metadata: { method: 'email' })
        render json: { error: 'verification_failed' }, status: :unauthorized
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
