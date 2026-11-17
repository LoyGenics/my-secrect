module Api
  module V1
    # TOTP MFA enrolment + management. The TOTP secret is returned ONCE
    # by enroll and must be shown once by the client; it is stored
    # server-side as MessageEncryptor ciphertext only. Recovery codes are
    # returned once at confirm/regenerate time; only digests are stored.
    # Enable/disable rotate the session token; disable and regenerate
    # require step-up.
    class MfaController < ApplicationController
      # POST /v1/auth/mfa/enroll — generate a secret + otpauth URL.
      # 422 when MFA is already enabled.
      def enroll
        result = Authentication::Totp.enroll(user: current_user)
        render json: result, status: :ok
      rescue Authentication::Totp::Error => e
        render json: { error: e.message }, status: :unprocessable_entity
      end

      # POST /v1/auth/mfa/confirm — confirm enrolment with a valid TOTP
      # code. Enables MFA, returns the 10 recovery codes (shown once),
      # and rotates the session token.
      def confirm
        result = Authentication::Totp.confirm(user: current_user, code: params[:code])
        render json: result.merge(rotated_token: rotate_current_session!), status: :ok
      rescue Authentication::Totp::VerificationError
        render json: { error: 'verification_failed' }, status: :unauthorized
      end

      # POST /v1/auth/mfa/disable — step-up required. Clears the secret
      # and all recovery codes; rotates the session token.
      def disable
        require_step_up!
        result = Authentication::Totp.disable(user: current_user)
        render json: result.merge(rotated_token: rotate_current_session!), status: :ok
      end

      # POST /v1/auth/mfa/recovery_codes — regenerate the 10 recovery
      # codes (replaces all existing ones). Step-up required; rotates
      # the session token. Returns the codes once.
      def regenerate_codes
        require_step_up!
        codes = Authentication::Totp.generate_recovery_codes(user: current_user)
        Audit::Log.call(user: current_user, device: current_device, event_type: 'mfa_recovery_codes_regenerated')
        render json: { recovery_codes: codes, rotated_token: rotate_current_session! }, status: :ok
      end
    end
  end
end
