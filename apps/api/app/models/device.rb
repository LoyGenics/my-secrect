class Device < ApplicationRecord
  belongs_to :user
  has_many :sync_events, dependent: :nullify
  has_many :device_checkpoints, dependent: :destroy
  validates :public_key, presence: true
  scope :active, -> { where(revoked_at: nil) }
  def revoked? = revoked_at.present?
  def touch_seen! = update!(last_seen_at: Time.current)
end
