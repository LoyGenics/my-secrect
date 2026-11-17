class Session < ApplicationRecord
  belongs_to :user
  belongs_to :device, optional: true
  validates :token_digest, presence: true, uniqueness: true
  validates :expires_at, presence: true
  scope :live, -> { where(revoked_at: nil).where('expires_at > ?', Time.current) }
  def expired? = expires_at <= Time.current
  def revoked? = revoked_at.present?
end
