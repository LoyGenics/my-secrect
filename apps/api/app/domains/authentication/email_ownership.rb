require 'securerandom'
require 'openssl'
require 'digest'
require 'net/smtp'

module Authentication
  # Proof of email ownership BEFORE an account exists.
  #
  #   1. request_code(email)  -> a 6-digit code is emailed (AuthMailer).
  #   2. verify_code(email, code) -> a short-lived registration ticket.
  #   3. Passkeys.registration_options(email, ticket) -> WebAuthn options.
  #   4. Passkeys.verify(kind: 'registration') -> the user row is created
  #      only now, together with its first authenticator, and the ticket
  #      is consumed in the same transaction.
  #
  # Rules (never weaken):
  #   * The code is never stored: only HMAC-SHA-256(server key,
  #     "<row id>:<code>") is. A database leak alone does not let anyone
  #     brute-force 10^6 codes offline (the key derives from
  #     secret_key_base), and the row id in the message makes equal codes
  #     in different rows hash differently.
  #   * TTL 10 minutes, at most MAX_ATTEMPTS guesses per code, single use.
  #     An attempt is reserved with one conditional UPDATE before the code
  #     is compared, so concurrent guesses cannot exceed the limit. The
  #     code is burned when its last attempt fails.
  #   * A new request supersedes every live code for that address, so
  #     guesses only accumulate as fast as the request throttle allows
  #     (config/initializers/rack_attack.rb).
  #   * No account enumeration: request_code returns the same body for
  #     every syntactically valid address and runs the same steps — a row
  #     with a fresh random code digest is stored either way. If the
  #     address belongs to an account with a passkey (User#passkey_account?),
  #     the code is NOT sent; the owner gets an "account already exists"
  #     notice instead, so no ticket can be minted for a passkey account.
  #   * The registration ticket ("rt_" + 64 hex) is shown once; only its
  #     SHA-256 is stored (it has 256 bits of entropy, so a plain hash is
  #     enough). TTL 10 minutes, consumed by the successful registration.
  #   * The code and the ticket are never logged: they are filtered params
  #     (config/application.rb), the mailer logger is off, and audit
  #     metadata only carries the opaque email_verification_id.
  #   * Mail goes out with deliver_now: a queued job would serialise the
  #     code into Redis and Active Job would log its arguments.
  module EmailOwnership
    class Error < StandardError; end
    class InvalidEmail < Error; end
    class DeliveryError < Error; end
    class VerificationError < Error; end

    CODE_TTL = 10.minutes
    TICKET_TTL = 10.minutes
    MAX_ATTEMPTS = 5
    CODE_DIGITS = 6
    CODE_FORMAT = /\A\d{#{CODE_DIGITS}}\z/
    TICKET_PREFIX = 'rt_'
    HMAC_SALT = 'my-secrect email-code v1'
    MAX_EMAIL_LENGTH = 254

    # What a failed delivery looks like (SMTP refusal, network, TLS, or a
    # file-delivery I/O error). Anything else is a bug and propagates.
    DELIVERY_ERRORS = [Net::SMTPError, Net::OpenTimeout, Net::ReadTimeout, Timeout::Error, IOError,
                       SocketError, SystemCallError, OpenSSL::SSL::SSLError].freeze

    module_function

    # Step 1. Returns { status: 'sent', expires_in: } for every valid
    # address. Raises InvalidEmail for a malformed address (that says
    # nothing about existence) and DeliveryError when mail cannot be sent.
    def request_code(email:)
      normalized = normalize!(email)
      user = User.find_by(email: normalized)
      code = random_code
      record = nil
      EmailVerification.transaction do
        now = Time.current
        EmailVerification.where(email: normalized, consumed_at: nil).update_all(consumed_at: now, updated_at: now)
        id = SecureRandom.uuid
        record = EmailVerification.create!(
          id: id, email: normalized, code_digest: code_digest(id, code),
          expires_at: now + CODE_TTL,
          # An unclaimed leftover row keeps its id; a new account gets a
          # fresh one now so the WebAuthn user handle is stable.
          pending_user_id: user&.id || SecureRandom.uuid
        )
      end
      message =
        if user&.passkey_account?
          AuthMailer.account_exists(email: normalized)
        else
          AuthMailer.verification_code(email: normalized, code: code, expires_in_minutes: CODE_TTL.in_minutes.to_i)
        end
      deliver!(message, record)
      Audit::Log.call(user: user, event_type: 'email_verification_requested',
                      metadata: { email_verification_id: record.id })
      { status: 'sent', expires_in: CODE_TTL.to_i }
    end

    # Step 2. Returns { registration_ticket:, expires_in: } or raises
    # VerificationError (one generic error for unknown address, no live
    # code, wrong code, expired code, or attempts exhausted).
    def verify_code(email:, code:)
      normalized = email.to_s.strip.downcase
      record = EmailVerification.where(email: normalized, consumed_at: nil, expires_at: Time.current..)
                                .order(created_at: :desc).first
      fail_verification!(nil, normalized) unless record

      reserved = EmailVerification.where(id: record.id, consumed_at: nil, attempts: ...MAX_ATTEMPTS,
                                         expires_at: Time.current..)
                                  .update_counters(attempts: 1)
      fail_verification!(record, normalized) unless reserved == 1

      unless code_matches?(record, code)
        now = Time.current
        EmailVerification.where(id: record.id, consumed_at: nil, attempts: MAX_ATTEMPTS..)
                         .update_all(consumed_at: now, updated_at: now)
        fail_verification!(record, normalized)
      end

      ticket = TICKET_PREFIX + SecureRandom.hex(32)
      now = Time.current
      # Single winner: a concurrent correct guess cannot mint a second ticket.
      won = EmailVerification.where(id: record.id, consumed_at: nil).update_all(
        consumed_at: now, verified_at: now, updated_at: now,
        ticket_digest: Digest::SHA256.hexdigest(ticket), ticket_expires_at: now + TICKET_TTL
      )
      fail_verification!(record, normalized) unless won == 1
      Audit::Log.call(user: User.find_by(email: normalized), event_type: 'email_verification_succeeded',
                      metadata: { email_verification_id: record.id })
      { registration_ticket: ticket, expires_in: TICKET_TTL.to_i }
    end

    # Verify a code and spend its ticket in one go, for flows that act on the
    # proof right away (email sign-in, email step-up). Returns the verified
    # EmailVerification; raises VerificationError like verify_code.
    def redeem_code!(email:, code:)
      normalized = email.to_s.strip.downcase
      ticket = verify_code(email: normalized, code: code)[:registration_ticket]
      record = live_ticket!(email: normalized, ticket: ticket)
      consume_ticket!(record)
      record
    end

    # The live (unexpired, unused) verification behind a ticket, or
    # VerificationError. Read-only: consume_ticket! is what spends it.
    def live_ticket!(email:, ticket:)
      raise VerificationError, 'verification failed' if ticket.blank?
      record = EmailVerification.where(
        email: email.to_s.strip.downcase, ticket_digest: Digest::SHA256.hexdigest(ticket.to_s),
        ticket_consumed_at: nil, ticket_expires_at: Time.current..
      ).first
      raise VerificationError, 'verification failed' unless record
      record
    end

    # Spend the ticket (one conditional UPDATE, single winner). Called
    # inside the registration transaction, so a failed attestation rolls
    # the consumption back and the user can retry while the ticket lives.
    def consume_ticket!(verification)
      now = Time.current
      won = EmailVerification.where(id: verification.id, ticket_consumed_at: nil, ticket_expires_at: now..)
                             .update_all(ticket_consumed_at: now, updated_at: now)
      raise VerificationError, 'verification failed' unless won == 1
    end

    # -- internals ---------------------------------------------------------

    def normalize!(email)
      normalized = email.to_s.strip.downcase
      valid = normalized.length <= MAX_EMAIL_LENGTH && URI::MailTo::EMAIL_REGEXP.match?(normalized)
      raise InvalidEmail, 'invalid email' unless valid
      normalized
    end

    # Uniform over 000000..999999.
    def random_code
      SecureRandom.random_number(10**CODE_DIGITS).to_s.rjust(CODE_DIGITS, '0')
    end

    def code_digest(id, code)
      OpenSSL::HMAC.hexdigest('SHA256', hmac_key, "#{id}:#{code}")
    end

    def hmac_key
      Rails.application.key_generator.generate_key(HMAC_SALT, 32)
    end

    def code_matches?(record, code)
      return false unless code.is_a?(String) && CODE_FORMAT.match?(code)
      ActiveSupport::SecurityUtils.secure_compare(record.code_digest, code_digest(record.id, code))
    end

    def deliver!(message, record)
      message.deliver_now
    rescue *DELIVERY_ERRORS => e
      # The code never reached anyone: retire it so it cannot be guessed.
      record.update_columns(consumed_at: Time.current)
      raise DeliveryError, e.class.name
    end

    # Attributed to an existing account when there is one, so its owner
    # sees guessing against their address in their activity list.
    def fail_verification!(record, email)
      Audit::Log.call(user: User.find_by(email: email), event_type: 'email_verification_failed',
                      metadata: record ? { email_verification_id: record.id } : {})
      raise VerificationError, 'verification failed'
    end
  end
end
