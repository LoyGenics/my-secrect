module Audit
  module Log
    module_function
    # Audit log: event types + ids only. Never log vault content, ciphertext
    # payloads, keys, or challenges.
    def call(user: nil, device: nil, event_type:)
      AuditEvent.create!(user: user, device: device, event_type: event_type)
    rescue StandardError
      nil # audit must never break the request it records
    end
  end
end
