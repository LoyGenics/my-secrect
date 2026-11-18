module ShareLinks
  class Create
    MAX_PAYLOAD = 262_144
    def self.call(owner:, id:, format_version:, expires_at:, encrypted_payload:, encrypted_owner_metadata:)
      expiry = Time.iso8601(expires_at.to_s)
      raise ArgumentError, 'invalid expiry' unless expiry > Time.current && expiry <= 7.days.from_now + 1.minute
      payload = Base64.strict_decode64(encrypted_payload.to_s)
      metadata = Base64.strict_decode64(encrypted_owner_metadata.to_s)
      raise ArgumentError, 'invalid ciphertext' unless payload.bytesize.between?(40, MAX_PAYLOAD) && metadata.bytesize.between?(40, 4096)
      owner.with_lock do
        raise ArgumentError, 'link limit reached' if ShareLink.available.where(owner: owner).count >= 100
        ShareLink.create!(owner: owner, id: id, format_version: format_version, expires_at: expiry, encrypted_payload: payload, encrypted_owner_metadata: metadata)
      end
    end
  end
end
