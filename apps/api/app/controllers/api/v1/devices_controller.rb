module Api
  module V1
    class DevicesController < ApplicationController
      # GET /v1/devices — devices of the current user, most recently seen first.
      def index
        render json: { devices: current_user.devices.order(last_seen_at: :desc).as_json(only: %i[id name_encrypted last_seen_at revoked_at created_at]) }
      end

      # POST /v1/devices/enroll — enrol a new device after account auth.
      # Body: { public_key: (base64, device signing key), name_encrypted: (base64) }
      # The device then needs the master passphrase (or trusted-device transfer)
      # to obtain the vault key — enrolment alone grants no vault access.
      def enroll
        device = Devices::Enroll.call(user: current_user, public_key: params[:public_key], name_encrypted: params[:name_encrypted])
        render json: { device: device.as_json(only: %i[id name_encrypted created_at]) }, status: :created
      end

      def create = enroll

      # DELETE /v1/devices/:id — revoke. Revoked devices can no longer sync;
      # their key envelopes must be rotated (see KeyEnvelopes::Rotate).
      def destroy
        device = current_user.devices.find(params[:id])
        Devices::Revoke.call(device: device)
        head :no_content
      end
    end
  end
end
