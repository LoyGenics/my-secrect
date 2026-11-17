module Api
  module V1
    class DevicesController < ApplicationController
      # GET /v1/devices — devices of the current user, most recently seen first.
      # Each device also says which passkey enrolled it and how many ACTIVE
      # devices that passkey enrolled (> 1 suggests a synced passkey shared
      # by several devices — revoking it signs all of them out of passkey
      # sign-in), and whether it is the device of this session.
      def index
        devices = current_user.devices.order(last_seen_at: :desc)
        per_passkey = current_user.devices.active.where.not(authenticator_id: nil).group(:authenticator_id).count
        render json: { devices: devices.map { |d| device_json(d, per_passkey) } }
      end

      # POST /v1/devices/challenges — fresh single-use challenge for the
      # explicit device flow (specs/device-identity.md §6.2). Body:
      # { purpose: 'enroll'|'session-bind' }. Bound to THIS session and
      # purpose; 2-minute TTL; only its SHA-256 is stored.
      def create_challenge
        render json: Authentication::DeviceProof.issue_challenge!(session: current_session, purpose: params[:purpose]),
               status: :created
      rescue Authentication::DeviceProof::VerificationError
        render json: { error: 'unknown_purpose' }, status: :unprocessable_entity
      end

      # POST /v1/devices/enroll — enrol a new device after account auth.
      # Step-up required AND proof of possession: the client signs a
      # challenge from /devices/challenges (purpose 'enroll') with the
      # private half of `public_key`. Body: { public_key: (base64url,
      # 32-byte Ed25519 key), challenge:, signature:, name_encrypted:,
      # platform: }. Binds the current session to the device only if the
      # session is unbound. The device then needs the master passphrase (or
      # trusted-device transfer) to obtain the vault key — enrolment alone
      # grants no vault access. Generic 401 for any proof failure.
      def enroll
        require_step_up!
        device = Authentication::DeviceProof.enroll!(
          session: current_session, public_key: params[:public_key], challenge: params[:challenge],
          signature: params[:signature], platform: params[:platform], name_encrypted: params[:name_encrypted]
        )
        render json: { device: device.as_json(only: %i[id name_encrypted platform trusted_at created_at]),
                       session_bound: current_session.device_id == device.id }, status: :created
      rescue Authentication::DeviceProof::ApprovalRequired
        render json: { error: 'device_approval_required' }, status: :forbidden
      rescue Authentication::DeviceProof::VerificationError
        render json: { error: 'device_verification_failed' }, status: :unauthorized
      end

      def create = enroll

      # POST /v1/devices/:id/bind — bind the current session to device :id.
      # Body: { challenge:, signature: } — a /devices/challenges challenge
      # (purpose 'session-bind') signed by that device's key. 409 when the
      # session is already bound; generic 401 for any proof failure.
      def bind
        device = Authentication::DeviceProof.bind!(session: current_session, device_id: params[:id],
                                                   challenge: params[:challenge], signature: params[:signature])
        render json: { device_id: device.id, session_bound: true }, status: :ok
      rescue Authentication::DeviceProof::AlreadyBound
        render json: { error: 'already_bound' }, status: :conflict
      rescue Authentication::DeviceProof::VerificationError
        render json: { error: 'device_verification_failed' }, status: :unauthorized
      end

      # PATCH /v1/devices/:id — rename (name_encrypted) and/or trust.
      # Body: { name_encrypted:, trusted: true|false }.
      # TRUST requires step-up; untrust and rename do not. Trusting only
      # marks the device record — it grants no vault access by itself.
      def update
        require_step_up! if params.key?(:trusted) && ActiveModel::Type::Boolean.new.cast(params[:trusted])
        device = current_user.devices.find(params[:id])
        device.update!(name_encrypted: params[:name_encrypted]) if params.key?(:name_encrypted)
        if params.key?(:trusted)
          if ActiveModel::Type::Boolean.new.cast(params[:trusted])
            device.update!(trusted_at: Time.current)
            Audit::Log.call(user: current_user, device: device, event_type: 'device_trusted')
          else
            device.update!(trusted_at: nil)
            Audit::Log.call(user: current_user, device: device, event_type: 'device_untrusted')
          end
        end
        render json: { device: device.as_json(only: %i[id name_encrypted platform trusted_at last_seen_at revoked_at created_at]) }, status: :ok
      end

      # DELETE /v1/devices/:id — revoke. Revoked devices can no longer sync;
      # their key envelopes must be rotated (see KeyEnvelopes::Rotate).
      # Revocation invalidates server sessions + rotates envelopes only —
      # it does NOT erase secrets already downloaded/offline on the device.
      # Durable (specs/device-identity.md §6.3): the passkey that enrolled
      # the device can no longer enrol a new device until re-approved from a
      # still-trusted device. With ?revoke_passkey=true that passkey is
      # revoked instead — step-up required, and refused (422) when it is the
      # last passkey and MFA is off. Response: 204, or with revoke_passkey
      # 200 { revoked:, passkey:, rotated_token: }. Revocation never erases
      # data already on the device.
      def destroy
        device = current_user.devices.find(params[:id])
        revoke_passkey = ActiveModel::Type::Boolean.new.cast(params[:revoke_passkey]) || false
        unless revoke_passkey
          Devices::Revoke.call(device: device)
          head :no_content and return
        end
        require_step_up!
        passkey = device.authenticator
        if passkey && !passkey.revoked? && current_user.authenticators.active.count <= 1 && !current_user.mfa_enabled?
          render json: { error: 'last_authenticator', detail: 'cannot remove the last passkey while MFA is disabled' },
                 status: :unprocessable_entity and return
        end
        result = Devices::Revoke.call(device: device, revoke_passkey: true)
        render json: { revoked: true, passkey: result, rotated_token: rotate_current_session! }, status: :ok
      end

      private

      def device_json(device, per_passkey)
        device.as_json(only: %i[id name_encrypted platform trusted_at last_seen_at revoked_at created_at authenticator_id])
              .merge('passkey_active_devices' => per_passkey.fetch(device.authenticator_id, 0),
                     'current' => device.id == current_device&.id)
      end
    end
  end
end
