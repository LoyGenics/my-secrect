# Read-only encrypted snapshots. No plaintext or decryption key is stored.
class ShareLink < ApplicationRecord
  belongs_to :owner, class_name: 'User'
  validates :id, format: { with: /\A[A-Za-z0-9_-]{32}\z/ }
  validates :format_version, inclusion: { in: [1] }
  validates :expires_at, presence: true
  validates :encrypted_payload, :encrypted_owner_metadata, presence: true, unless: :revoked?
  scope :available, -> { where(revoked_at: nil).where(expires_at: Time.current..) }
  def revoked? = revoked_at.present?
  def available? = !revoked? && expires_at > Time.current
end
