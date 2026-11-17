module Devices
  module Enroll
    module_function
    def call(user:, public_key:, name_encrypted: nil)
      device = user.devices.create!(public_key: public_key, name_encrypted: name_encrypted, last_seen_at: Time.current)
      Audit::Log.call(user: user, device: device, event_type: 'device_enrolled')
      device
    end
  end
end
