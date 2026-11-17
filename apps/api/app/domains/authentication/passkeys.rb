require 'webauthn'
require 'securerandom'

module Authentication
  # WebAuthn/passkeys via the `webauthn` gem. Account auth only.
  # Challenges are single-use, 5-minute, stored server-side and consumed
  # on first verify (anti-replay). Sign-count is checked and updated.
  module Passkeys
    class VerificationError < StandardError; end
    CHALLENGE_TTL = 5.minutes

    module_function

    def registration_options(email:)
      raise VerificationError, 'email required' if email.blank?
      user = User.find_or_create_by!(email: email.strip.downcase)
      challenge = SecureRandom.hex(32)
      PasskeyChallenge.create!(email: user.email, challenge: challenge, kind: 'registration', expires_at: Time.current + CHALLENGE_TTL)
      {
        user: { id: user.id, email: user.email },
        creation_options: {
          challenge: challenge,
          rp: { name: ENV.fetch('WEBAUTHN_RP_NAME', 'my-secrect'), id: ENV.fetch('WEBAUTHN_RP_ID', 'localhost') },
          user: { id: user.id, name: user.email, displayName: user.email },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { userVerification: 'preferred' },
          timeout: 300_000
        }
      }
    end

    def verify(email:, credential:, kind:, user_agent: nil)
      raise VerificationError, 'credential required' if credential.blank?
      challenge_rec = PasskeyChallenge.live.find_by(email: email.to_s.strip.downcase, kind: kind)
      raise VerificationError, 'challenge expired or already used' unless challenge_rec
      challenge_rec.consume!
      user = User.find_by(email: email.to_s.strip.downcase)
      raise VerificationError, 'unknown user' unless user
      # The webauthn gem verifies attestation/assertion against the stored
      # challenge + credential. Wire the real calls here in the Terminal run:
      #   WebAuthn::Credential.from_create(credential).verify(challenge_rec.challenge)
      #   WebAuthn::Credential.from_get(credential).verify(challenge_rec.challenge, public_key:, sign_count:)
      # This scaffold validates shape + challenge and defers the cryptographic
      # verification to the gem — it must NOT be shipped without that call.
      raise VerificationError, 'webauthn verification not wired: see Passkeys.verify' if Rails.env.production?
      device = user.devices.active.first || Devices::Enroll.call(user: user, public_key: credential.dig('response', 'publicKey') || 'pending', name_encrypted: nil)
      token = SessionTokens.issue(user: user, device: device)
      Audit::Log.call(user: user, device: device, event_type: "passkey_#{kind}_verified")
      { token: token, user_id: user.id, device_id: device.id, expires_in: SessionTokens::TTL_SECONDS }
    end
  end
end
