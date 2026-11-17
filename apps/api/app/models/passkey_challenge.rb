class PasskeyChallenge < ApplicationRecord
  validates :email, :challenge, :expires_at, presence: true
  scope :live, -> { where(consumed_at: nil).where('expires_at > ?', Time.current) }
  def consume! = update!(consumed_at: Time.current)
end
