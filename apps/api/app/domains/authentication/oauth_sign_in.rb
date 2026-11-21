module Authentication
  # Sign in (or sign up) with Google or Apple (specs/account-sign-in.md).
  #
  #   1. OauthStart.call -> { ticket, nonce }; the client gets an ID token
  #      from the provider for that nonce.
  #   2. call(provider, ticket, id_token, device?) -> session, exactly like
  #      EmailSignIn (same device proof, MFA branch and response).
  #
  # Rules (never weaken):
  #   * The ID token is verified (IdToken) against the ticket's nonce
  #     before anything else is written. A token that fails verification
  #     spends the ticket, so one ticket cannot be retried with new tokens.
  #   * Linking: a known (provider, subject) signs in to its user. Otherwise
  #     the provider's verified email finds or creates the user and the
  #     identity is recorded. Only an authoritative email (IdToken) may link
  #     to an EXISTING account; a non-authoritative Google email may only
  #     create a new one. An account with a passkey is never linked by
  #     email: email possession alone is not enough for it
  #     (specs/device-identity.md §6.3), as for EmailSignIn.
  #   * The ticket, the user row, the identity and the device commit
  #     together: a bad device proof rolls everything back and the ticket
  #     stays usable. The device proof signs the raw nonce.
  #   * One generic VerificationError for every refusal; nothing is logged
  #     but opaque ids and the provider name. A refusal is audited only on
  #     an account the token really identifies: its (provider, subject) or
  #     its authoritative email.
  #   * The vault key is untouched: the client still needs the passphrase.
  module OauthSignIn
    class VerificationError < StandardError; end

    module_function

    def call(provider:, ticket:, id_token:, device: nil, user_agent: nil, ip_address: nil)
      record = OauthStart.live_ticket!(ticket)
      nonce = OauthStart.nonce_for(ticket)
      claims = verified_claims!(record: record, provider: provider, id_token: id_token, nonce: nonce)

      created = false
      user = nil
      step = ActiveRecord::Base.transaction do
        OauthStart.consume!(record)
        user, created = find_or_create_user!(provider: provider, claims: claims)
        SignInCompletion.prove_device!(user: user, challenge: nonce, device: device)
      end
      Audit::Log.call(user: user, event_type: 'account_created', metadata: { method: provider }) if created
      SignInCompletion.finish(user: user, step: step, method: provider, account_created: created,
                              user_agent: user_agent, ip_address: ip_address)
    rescue VerificationError, OauthStart::VerificationError, IdToken::VerificationError,
           ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique
      audit_failure(provider, claims)
      raise VerificationError, 'verification failed'
    rescue DeviceProof::VerificationError
      audit_failure(provider, claims)
      raise
    end

    def verified_claims!(record:, provider:, id_token:, nonce:)
      IdToken.verify!(provider: provider, id_token: id_token, nonce: nonce)
    rescue IdToken::VerificationError
      OauthStart.consume!(record)
      raise
    end

    # [user, created]
    def find_or_create_user!(provider:, claims:)
      identity = UserIdentity.find_by(provider: provider, subject: claims[:subject])
      return [User.lock.find(identity.user_id), false] if identity

      user = User.lock.find_by(email: claims[:email])
      raise VerificationError, 'verification failed' if user && !linkable_by_email?(user, claims)

      created = user.nil?
      user ||= User.create!(email: claims[:email])
      user.user_identities.create!(provider: provider, subject: claims[:subject], email: claims[:email])
      [user, created]
    end

    def linkable_by_email?(user, claims)
      claims[:email_authoritative] && !user.passkey_account?
    end

    # nil for a failed token (claims nil). A rolled-back sign-up leaves no
    # account behind, so it is attributed to none.
    def audit_failure(provider, claims)
      Audit::Log.call(user: identified_user(provider, claims), event_type: 'sign_in_failed',
                      metadata: { method: provider.to_s })
    end

    def identified_user(provider, claims)
      return nil unless claims
      identity = UserIdentity.find_by(provider: provider, subject: claims[:subject])
      return identity.user if identity
      User.find_by(email: claims[:email]) if claims[:email_authoritative]
    end
  end
end
