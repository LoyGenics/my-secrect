module Authentication
  # Step-up authentication: a recent second-factor verification bound to
  # the current session, required before privileged actions (device
  # enrol/trust, passkey add/remove, MFA disable, recovery-code
  # regenerate, recovery verifier register, revoke-other-sessions).
  # A step-up lasts 10 minutes and is per-session: logging in again
  # does not inherit it. Completing MFA at login does NOT count as a
  # step-up — step-up is always an explicit re-verification.
  module StepUp
    class StepUpRequired < StandardError; end
    class VerificationError < StandardError; end

    WINDOW = 10.minutes

    module_function

    def verified?(session)
      session&.step_up_verified_at.present? && session.step_up_verified_at >= WINDOW.ago
    end

    def require!(session)
      raise StepUpRequired, 'step_up_required' unless verified?(session)
    end

    def mark_verified!(session, method:)
      session.update!(step_up_verified_at: Time.current, step_up_method: method.to_s)
      Audit::Log.call(user: session.user, device: session.device,
                      event_type: 'step_up_verified', metadata: { method: method.to_s })
      session
    end

    # Email step-up, only for an account whose sole login factor is the
    # email (no passkey, no MFA): it is no weaker than the login itself, and
    # it is what lets such an account add its first passkey. Anyone else
    # must use the passkey or TOTP.
    def email_allowed?(user)
      !user.passkey_account? && !user.mfa_enabled?
    end

    def request_email_code(user:)
      raise VerificationError, 'verification failed' unless email_allowed?(user)
      EmailOwnership.request_code(email: user.email)
    end

    def verify_email(user:, code:, session:)
      raise VerificationError, 'verification failed' unless email_allowed?(user)
      EmailOwnership.redeem_code!(email: user.email, code: code)
      mark_verified!(session, method: 'email')
      true
    rescue EmailOwnership::VerificationError
      raise VerificationError, 'verification failed'
    end

    # Verify a passkey assertion as a step-up. Reuses the stored
    # 'authentication' challenge + the STORED public key (never a
    # client-supplied key) via the same gem verification as login.
    # Marks the session verified; issues NO new session token.
    def verify_passkey(user:, credential:, session:)
      challenge_rec = ::PasskeyChallenge.live.where(email: user.email, kind: 'authentication')
                                             .order(created_at: :desc).first
      raise VerificationError, 'verification failed' unless challenge_rec
      raise VerificationError, 'verification failed' unless challenge_rec.consume!
      params = Passkeys.normalize_credential_params(credential)
      Passkeys.verify_authentication(user: user, params: params, challenge: challenge_rec.challenge)
      mark_verified!(session, method: 'passkey')
      true
    rescue VerificationError
      raise
    rescue WebAuthn::Error, ArgumentError, TypeError, NoMethodError, RuntimeError
      raise VerificationError, 'verification failed'
    end
  end
end
