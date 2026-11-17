class RecoveryChallenge < ApplicationRecord
  belongs_to :user
  validates :challenge_digest, :challenge_encrypted, :kind, :expires_at, presence: true
  validates :kind, inclusion: { in: %w[recovery_key passphrase trusted_device] }
  scope :live, -> { where(consumed_at: nil).where('expires_at > ?', Time.current) }
  def consume! = update!(consumed_at: Time.current)
  def consumed? = consumed_at.present?
  def expired? = expires_at <= Time.current
end
