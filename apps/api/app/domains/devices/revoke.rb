module Devices
  module Revoke
    module_function
    # Revoking a device: mark revoked, revoke its sessions, and schedule
    # key-envelope rotation so its wrapped vault key stops working.
    def call(device:)
      device.update!(revoked_at: Time.current)
      Session.where(device: device).update_all(revoked_at: Time.current)
      KeyEnvelopes::Rotate.call(vault_ids: device.user.vaults.pluck(:id), revoked_recipient_id: device.id)
      Audit::Log.call(user: device.user, device: device, event_type: 'device_revoked')
      device
    end
  end
end
