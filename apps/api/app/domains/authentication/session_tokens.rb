require 'securerandom'
require 'digest'

module Authentication
  # Short-lived Bearer session tokens. Only the SHA-256 digest is stored;
  # the raw token is shown to the client once. TTL 1h, revocable.
  # Account auth only — a session never decrypts vault content and never
  # carries a vault key (see specs/key-management.md).
  #
  # Revocation semantics: revoking a session (or a device) invalidates
  # the server-side session and triggers key-envelope rotation for that
  # device — it does NOT erase secrets already downloaded or cached
  # offline on that device. Clients must treat revocation as
  # "no further server access", not as remote wipe.
  module SessionTokens
    TTL_SECONDS = ENV.fetch('SESSION_TOKEN_TTL_SECONDS', 3600).to_i
    RECOVERY_TTL_SECONDS = 900 # 15 minutes for recovery sessions
    PREFIX = 'sess_'

    module_function

    def issue(user:, device: nil, user_agent: nil, ip_address: nil,
              expires_in: TTL_SECONDS, recovery_session: false,
              step_up_verified_at: nil, step_up_method: nil)
      raw = PREFIX + SecureRandom.hex(32)
      Session.create!(
        user: user, device: device,
        token_digest: Digest::SHA256.hexdigest(raw),
        expires_at: Time.current + expires_in,
        user_agent: user_agent, ip_address: ip_address,
        recovery_session: recovery_session,
        step_up_verified_at: step_up_verified_at, step_up_method: step_up_method
      )
      raw
    end

    # Returns { user:, device:, session: } or nil. Also touches device last_seen_at.
    def verify(raw_token)
      return nil if raw_token.blank? || !raw_token.start_with?(PREFIX)
      session = Session.live.find_by(token_digest: Digest::SHA256.hexdigest(raw_token))
      return nil unless session
      session.device&.touch_seen!
      { user: session.user, device: session.device, session: session }
    end

    def revoke(raw_token)
      Session.find_by(token_digest: Digest::SHA256.hexdigest(raw_token.to_s))&.update!(revoked_at: Time.current)
    end

    # Revoke the old token and issue a fresh one for the same user/device,
    # preserving user_agent/ip, step-up state and the recovery flag.
    # Called on privilege changes (MFA enable/disable, passkey add/remove,
    # recovery verifier register, recovery-code regenerate) so a token
    # stolen before the change stops working. Returns the new raw token,
    # or nil when the old token has no live session.
    def rotate(raw_token)
      return nil if raw_token.blank?
      old_session = Session.live.find_by(token_digest: Digest::SHA256.hexdigest(raw_token))
      return nil unless old_session
      old_session.update!(revoked_at: Time.current)
      expires_in = old_session.recovery_session ? RECOVERY_TTL_SECONDS : TTL_SECONDS
      issue(
        user: old_session.user, device: old_session.device,
        user_agent: old_session.user_agent, ip_address: old_session.ip_address,
        expires_in: expires_in, recovery_session: old_session.recovery_session,
        step_up_verified_at: old_session.step_up_verified_at,
        step_up_method: old_session.step_up_method
      )
    end
  end
end
