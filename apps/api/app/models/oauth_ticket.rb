# One Sign in with Google/Apple attempt: the SHA-256 of a single-use,
# 10-minute ticket. The nonce is derived from the ticket and never stored.
# See Authentication::OauthStart.
class OauthTicket < ApplicationRecord
  validates :ticket_digest, :expires_at, presence: true
end
