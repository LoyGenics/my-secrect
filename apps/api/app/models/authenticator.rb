class Authenticator < ApplicationRecord
  belongs_to :user
  validates :credential_id, presence: true, uniqueness: true
  validates :public_key, presence: true
  validates :sign_count, numericality: { greater_than_or_equal_to: 0 }
  scope :active, -> { where(revoked_at: nil) }
  # Devices this passkey's sign-ins enrolled (specs/device-identity.md §6.3).
  has_many :devices, dependent: :nullify
  def revoked? = revoked_at.present?
  # A device this passkey enrolled was revoked: until re-approved from a
  # still-trusted device, it may sign in only by binding an ACTIVE device.
  def reapproval_required? = reapproval_required_at.present?
end
