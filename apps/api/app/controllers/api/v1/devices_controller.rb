module Api
  module V1
    class DevicesController < ApplicationController
      # GET /v1/devices — devices of the current user, most recently seen first.
      def index
        render json: { devices: current_user.devices.order(last_seen_at: :desc).as_json(only: %i[id name_encrypted platform trusted_at last_seen_at revoked_at created_at]) }
      end

      # POST /v1/devices/enroll — enrol a new device after account auth.
      # Step-up required. Body: { public_key: (base64, device signing key),
      # name_encrypted: (base64), platform: (e.g. 'macOS') }
      # The device then needs the master passphrase (or trusted-device transfer)
      # to obtain the vault key — enrolment alone grants no vault access.
      def enroll
        require_step_up!
        device = Devices::Enroll.call(user: current_user, public_key: params[:public_key],
                                      name_encrypted: params[:name_encrypted], platform: params[:platform])
        render json: { device: device.as_json(only: %i[id name_encrypted platform trusted_at created_at]) }, status: :created
      end

      def create = enroll

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
