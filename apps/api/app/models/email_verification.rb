# One sign-up email-ownership check: a 6-digit code (digest only) and, once
# verified, a short-lived registration ticket (digest only). See
# Authentication::EmailOwnership for the rules.
class EmailVerification < ApplicationRecord
  has_many :passkey_challenges, dependent: :delete_all
  validates :email, :code_digest, :expires_at, :pending_user_id, presence: true
end
