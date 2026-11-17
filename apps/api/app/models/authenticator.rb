class Authenticator < ApplicationRecord
  belongs_to :user
  validates :credential_id, presence: true, uniqueness: true
  validates :public_key, presence: true
  validates :sign_count, numericality: { greater_than_or_equal_to: 0 }
  scope :active, -> { where(revoked_at: nil) }
  def revoked? = revoked_at.present?
end
