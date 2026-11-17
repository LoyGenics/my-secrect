require 'securerandom'
require 'digest'

module Authentication
  # Short-lived Bearer session tokens. Only the SHA-256 digest is stored;
  # the raw token is shown to the client once. TTL 1h, revocable.
  module SessionTokens
    TTL_SECONDS = ENV.fetch('SESSION_TOKEN_TTL_SECONDS', 3600).to_i
    PREFIX = 'sess_'

    module_function

    def issue(user:, device: nil)
      raw = PREFIX + SecureRandom.hex(32)
      Session.create!(user: user, device: device, token_digest: Digest::SHA256.hexdigest(raw), expires_at: Time.current + TTL_SECONDS)
      raw
    end

    # Returns { user:, device: } or nil. Also touches device last_seen_at.
    def verify(raw_token)
      return nil if raw_token.blank? || !raw_token.start_with?(PREFIX)
      session = Session.live.find_by(token_digest: Digest::SHA256.hexdigest(raw_token))
      return nil unless session
      session.device&.touch_seen!
      { user: session.user, device: session.device }
    end

    def revoke(raw_token)
      Session.find_by(token_digest: Digest::SHA256.hexdigest(raw_token.to_s))&.update!(revoked_at: Time.current)
    end
  end
end
