require 'digest'

class RecoveryVerifier < ApplicationRecord
  # specs/recovery-protocol.md "Recovery verifier key": v1 = Ed25519 seed
  # HKDF-derived from the recovery key with a domain label; v0 = the
  # recovery key itself (legacy rows only, still accepted for sign-in).
  DERIVATION_V1 = 'v1-hkdf-sha256'.freeze
  DERIVATION_LEGACY = 'v0-raw-recovery-key'.freeze

  belongs_to :user
  validates :public_key, presence: true
  validates :derivation, inclusion: { in: [DERIVATION_V1, DERIVATION_LEGACY] }
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
