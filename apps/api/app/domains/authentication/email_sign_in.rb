module Authentication
  # Sign-in / sign-up with proof of email ownership alone — the default for
  # an account that has no passkey yet. A passkey is added later from the
  # signed-in app (Passkeys.add_registration_options) and then replaces this.
  #
  #   1. EmailOwnership.request_code / verify_code -> registration ticket.
  #   2. call(email, ticket, device?) -> session (creates the user on first use).
  #
  # Rules (never weaken):
  #   * Closed for an account with a passkey (User#passkey_account?): the
  #     code is never even mailed for it (EmailOwnership.request_code), and
  #     this refuses it again. Email possession alone is not enough there
  #     (specs/device-identity.md §6.3).
  #   * The ticket is the device-proof challenge (server-issued, 256 bits,
  #     single use): `device` is { public_key, signature, ... } (enrol) or
  #     { id, signature } (bind), exactly as for a passkey sign-in
  #     (specs/device-identity.md §6.1). Without it the session is unbound
  #     and cannot reach vault data (ActiveDeviceRequired).
  #   * The ticket, the user row and the device commit together: a bad
  #     device proof rolls everything back and the ticket stays usable.
  #   * MFA enabled: no session yet — { mfa_required:, mfa_token: }, finished
  #     by Totp.complete_mfa_login; the proven device is held on that token.
  #   * One generic VerificationError for every refusal; nothing is logged
  #     but opaque ids.
  module EmailSignIn
    module_function

    def call(email:, registration_ticket:, device: nil, user_agent: nil, ip_address: nil)
      normalized = email.to_s.strip.downcase
      verification = EmailOwnership.live_ticket!(email: normalized, ticket: registration_ticket)

      created = false
      user = nil
      step = ActiveRecord::Base.transaction do
        EmailOwnership.consume_ticket!(verification)
        user = User.lock.find_by(email: normalized)
        if user
          fail_verification! if user.passkey_account? || user.id != verification.pending_user_id
        else
          user = User.create!(id: verification.pending_user_id, email: normalized)
          created = true
        end
        SignInCompletion.prove_device!(user: user, challenge: registration_ticket, device: device)
      end
      Audit::Log.call(user: user, event_type: 'account_created',
                      metadata: { email_verification_id: verification.id }) if created
      SignInCompletion.finish(user: user, step: step, method: 'email_code', account_created: created,
                              user_agent: user_agent, ip_address: ip_address)
    rescue EmailOwnership::VerificationError, ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique
      audit_failure(normalized)
      raise EmailOwnership::VerificationError, 'verification failed'
    rescue DeviceProof::VerificationError
      audit_failure(normalized)
      raise
    end

    def fail_verification!
      raise EmailOwnership::VerificationError, 'verification failed'
    end

    def audit_failure(email)
      Audit::Log.call(user: User.find_by(email: email), event_type: 'sign_in_failed', metadata: { method: 'email_code' })
    end
  end
end
