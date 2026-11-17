require 'digest'

class RecoveryVerifier < ApplicationRecord
  belongs_to :user
  validates :public_key, presence: true
  scope :active, -> { where(revoked_at: nil) }
  def revoked? = revoked_at.present?
  # First 16 hex chars of SHA-256(raw key bytes). The full key is public
  # by nature, but the API returns fingerprints only — minimal surface.
  def fingerprint
    raw = Base64.strict_decode64(public_key)
    Digest::SHA256.hexdigest(raw)[0, 16]
  rescue ArgumentError
    'invalid'
  end
end
