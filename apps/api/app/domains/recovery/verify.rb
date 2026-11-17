require 'rbnacl'
require 'digest'

module Recovery
  # Verify a recovery-challenge answer: an Ed25519 signature over the
  # exact challenge bytes, made with the private half of a registered
  # recovery verifier (Recovery::Verifiers). On success the challenge is
  # consumed and a short-lived RECOVERY session is issued (15 min,
  # recovery_session: true, step-up verified at issue time). The
  # recovery session is an ACCOUNT session only — it never decrypts or
  # recovers a vault key.
  #
  # Every failure is the same generic error: no detail is leaked about
  # whether the challenge, the email, the signature, or the expiry was
  # wrong. After 5 failed attempts a challenge is consumed.
  module Verify
    class VerificationError < StandardError; end

    MAX_ATTEMPTS = 5

    module_function

    def verify(challenge_id:, email:, signature_b64:, user_agent: nil, ip_address: nil)
      user = User.find_by(email: email.to_s.strip.downcase)
      raise VerificationError, 'verification failed' unless user
      challenge = user.recovery_challenges.live.find_by(id: challenge_id.to_s)
      raise VerificationError, 'verification failed' unless challenge
      challenge.with_lock { challenge.increment!(:attempts) }
      unless signature_valid?(user: user, challenge: challenge, signature_b64: signature_b64)
        challenge.consume! if challenge.attempts >= MAX_ATTEMPTS
        raise VerificationError, 'verification failed'
      end
      # Consume under a lock, re-checking, so two concurrent verifies of
      # the same challenge cannot both mint a session.
      challenge.with_lock do
        raise VerificationError, 'verification failed' if challenge.consumed_at.present? || challenge.expired?
        challenge.update!(consumed_at: Time.current)
      end
      device = user.devices.active.first
      token = Authentication::SessionTokens.issue(
        user: user, device: device,
        user_agent: user_agent, ip_address: ip_address,
        expires_in: Authentication::SessionTokens::RECOVERY_TTL_SECONDS,
        recovery_session: true,
        step_up_verified_at: Time.current, step_up_method: 'recovery_key'
      )
      Audit::Log.call(user: user, device: device, event_type: 'recovery_verified')
      { token: token, user_id: user.id, device_id: device&.id,
        expires_in: Authentication::SessionTokens::RECOVERY_TTL_SECONDS, recovery_session: true }
    end

    # -- internals ---------------------------------------------------------

    def signature_valid?(user:, challenge:, signature_b64:)
      challenge_b64 = Authentication::SecretEncryptor.decrypt(challenge.challenge_encrypted, salt: Challenge::SALT)
      challenge_bytes = Authentication::SecretEncryptor.decode_base64_loose(challenge_b64)
      signature = Authentication::SecretEncryptor.decode_base64_loose(signature_b64)
      user.recovery_verifiers.active.any? do |verifier|
        begin
          key_bytes = Authentication::SecretEncryptor.decode_base64_loose(verifier.public_key)
          RbNaCl::VerifyKey.new(key_bytes).verify(signature, challenge_bytes)
          true
        rescue RbNaCl::BadSignatureError, RbNaCl::LengthError, ArgumentError
          false
        end
      end
    rescue ActiveSupport::MessageEncryptor::InvalidMessage, ActiveSupport::MessageVerifier::InvalidSignature, ArgumentError
      false
    end
  end
end
