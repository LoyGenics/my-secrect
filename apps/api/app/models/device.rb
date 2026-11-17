class Device < ApplicationRecord
  belongs_to :user
  # The passkey whose sign-in enrolled this device (nil for devices enrolled
  # before durable revocation, or from a recovery session).
  belongs_to :authenticator, optional: true
  has_many :sync_events, dependent: :nullify
  has_many :device_checkpoints, dependent: :destroy
  validates :public_key, presence: true
  scope :active, -> { where(revoked_at: nil) }
  def revoked? = revoked_at.present?
  def touch_seen! = update!(last_seen_at: Time.current)
end
