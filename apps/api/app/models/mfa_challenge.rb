class MfaChallenge < ApplicationRecord
  belongs_to :user
  belongs_to :device, optional: true
  validates :token_digest, :expires_at, presence: true
  scope :live, -> { where(consumed_at: nil).where('expires_at > ?', Time.current) }
  def consume! = update!(consumed_at: Time.current)
  def consumed? = consumed_at.present?
  def expired? = expires_at <= Time.current
end
