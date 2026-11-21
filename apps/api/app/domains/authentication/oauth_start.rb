require 'base64'
require 'digest'
require 'openssl'
require 'securerandom'

module Authentication
  # Step 1 of Sign in with Google / Apple: a single-use ticket and the
  # nonce the client hands to the identity provider
  # (specs/account-sign-in.md).
  #
  # Rules (never weaken):
  #   * The ticket ("ot_" + 64 hex, 256 bits) is shown once; only its
  #     SHA-256 is stored. TTL 10 minutes, spent by a successful sign-in.
  #   * The nonce is HMAC-SHA-256(server key, ticket), base64url. It is
  #     never stored: the server recomputes it from the presented ticket.
  #     It must be recomputable because Apple's token carries only
  #     SHA-256(nonce), while the device proof signs the raw nonce.
  #   * Unknown, expired or spent ticket: one generic VerificationError.
  module OauthStart
    class VerificationError < StandardError; end

    TTL = 10.minutes
    TICKET_PREFIX = 'ot_'
    HMAC_SALT = 'my-secrect oauth-nonce v1'

    module_function

    def call
      ticket = TICKET_PREFIX + SecureRandom.hex(32)
      record = OauthTicket.create!(ticket_digest: Digest::SHA256.hexdigest(ticket), expires_at: Time.current + TTL)
      { ticket: ticket, nonce: nonce_for(ticket), expires_at: record.expires_at }
    end

    def nonce_for(ticket)
      Base64.urlsafe_encode64(OpenSSL::HMAC.digest('SHA256', hmac_key, ticket.to_s), padding: false)
    end

    # The live ticket row, or VerificationError. Read-only.
    def live_ticket!(ticket)
      raise VerificationError, 'verification failed' unless ticket.is_a?(String) && ticket.present?
      record = OauthTicket.find_by(ticket_digest: Digest::SHA256.hexdigest(ticket), consumed_at: nil,
                                   expires_at: Time.current..)
      raise VerificationError, 'verification failed' unless record
      record
    end

    # Spend the ticket (one conditional UPDATE, single winner), inside the
    # sign-in transaction so a bad device proof leaves it usable.
    def consume!(record)
      now = Time.current
      won = OauthTicket.where(id: record.id, consumed_at: nil, expires_at: now..)
                       .update_all(consumed_at: now, updated_at: now)
      raise VerificationError, 'verification failed' unless won == 1
    end

    def hmac_key
      Rails.application.key_generator.generate_key(HMAC_SALT, 32)
    end
  end
end
