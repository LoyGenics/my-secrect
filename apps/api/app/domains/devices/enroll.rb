module Devices
  module Enroll
    module_function
    # Callers must have verified proof of possession of `public_key` first
    # (Authentication::DeviceProof); public_key_alg 'ed25519' marks such a
    # device as able to bind sessions.
    def call(user:, public_key:, name_encrypted: nil, platform: nil, public_key_alg: nil)
      device = user.devices.create!(public_key: public_key, public_key_alg: public_key_alg, name_encrypted: name_encrypted,
                                    platform: platform, last_seen_at: Time.current)
      Audit::Log.call(user: user, device: device, event_type: 'device_enrolled')
      device
    end
  end
end
