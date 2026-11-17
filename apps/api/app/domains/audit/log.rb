module Audit
  module Log
    module_function
    # Audit log: event types + ids + small metadata only. Never log vault
    # content, ciphertext payloads, keys, challenges, codes, or tokens.
    # metadata carries counts/methods (e.g. { method: 'totp' }) — never
    # a secret value.
    def call(user: nil, device: nil, event_type:, metadata: {})
      AuditEvent.create!(user: user, device: device, event_type: event_type, metadata: metadata)
    rescue StandardError
      nil # audit must never break the request it records
    end
  end
end
