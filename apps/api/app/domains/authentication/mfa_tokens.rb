require 'securerandom'
require 'digest'

module Authentication
  # Single-use, 5-minute MFA pending tokens. Issued by Passkeys.verify
  # (authentication kind) when the user has MFA enabled, instead of a
  # full session: the client must then present a TOTP or recovery code
  # to Authentication::Totp.complete_mfa_login. Only the SHA-256 digest
  # is stored; the raw token is shown once. Consuming is atomic — a token
  # burns on first use whether the second factor succeeds or not.
  module MfaTokens
    TOKEN_PREFIX = 'mfa_'
    TTL = 5.minutes

    module_function

    def issue(user:, device: nil)
      raw = TOKEN_PREFIX + SecureRandom.hex(32)
      ::MfaChallenge.create!(
        user: user, device: device,
        token_digest: Digest::SHA256.hexdigest(raw),
        expires_at: Time.current + TTL
      )
      raw
    end

    # Returns the consumed MfaChallenge record, or nil when the token is
    # unknown, expired, or already used. The record is consumed (under a
    # row lock, re-checked) before the caller verifies the second factor.
    def consume(raw_token)
      return nil if raw_token.blank?
      record = ::MfaChallenge.live.find_by(token_digest: Digest::SHA256.hexdigest(raw_token.to_s))
      return nil unless record
      record.with_lock do
        return nil if record.consumed_at.present? || record.expired?
        record.update!(consumed_at: Time.current)
      end
      record
    end
  end
end
