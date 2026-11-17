require 'securerandom'
require 'digest'

module Recovery
  # Account-recovery challenge. The server issues a single-use, 5-minute
  # challenge and PERSISTS it (H5 fix — the old version returned a
  # challenge that was never stored, so nothing could ever verify it).
  #
  # Only the SHA-256 digest and a MessageEncryptor ciphertext of the
  # challenge are stored — never the raw challenge — so a database read
  # alone cannot answer a challenge. The client answers by signing the
  # challenge bytes with its recovery key; see Recovery::Verify.
  #
  # Unknown emails get the same response shape with a random, unpersisted
  # challenge and a nil challenge_id, so the response never leaks whether
  # the account exists. If the user lost every key + trusted device,
  # there is NO recovery — by design; the server can never derive a
  # vault key from recovery.
  module Challenge
    KINDS = %w[recovery_key passphrase trusted_device].freeze
    TTL = 5.minutes
    SALT = 'my-secrect recovery v1'

    module_function

    def call(email:, kind: 'recovery_key')
      kind = KINDS.include?(kind.to_s) ? kind.to_s : 'recovery_key'
      raw = SecureRandom.random_bytes(32)
      challenge_b64 = Authentication::SecretEncryptor.encode_base64url(raw)
      user = User.find_by(email: email.to_s.strip.downcase)
      return { challenge_id: nil, challenge: challenge_b64, kind: kind, expires_in: TTL.to_i } if user.nil?
      record = ::RecoveryChallenge.create!(
        user: user,
        challenge_digest: Digest::SHA256.hexdigest(raw),
        challenge_encrypted: Authentication::SecretEncryptor.encrypt(challenge_b64, salt: SALT),
        kind: kind,
        expires_at: Time.current + TTL
      )
      { challenge_id: record.id, challenge: challenge_b64, kind: kind, expires_in: TTL.to_i }
    end
  end
end
