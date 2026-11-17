class RecoveryCode < ApplicationRecord
  belongs_to :user
  validates :code_digest, presence: true
  scope :unused, -> { where(used_at: nil) }
  def used? = used_at.present?
end
