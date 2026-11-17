module Api
  module V1
    class DevicesController < ApplicationController
      # GET /v1/devices — devices of the current user, most recently seen first.
      def index
        render json: { devices: current_user.devices.order(last_seen_at: :desc).as_json(only: %i[id name_encrypted platform trusted_at last_seen_at revoked_at created_at]) }
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
      def destroy
        device = current_user.devices.find(params[:id])
        Devices::Revoke.call(device: device)
        head :no_content
      end
    end
  end
end
