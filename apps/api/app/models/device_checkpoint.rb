class DeviceCheckpoint < ApplicationRecord
  belongs_to :device
  belongs_to :vault
  validates :last_sequence, numericality: { greater_than_or_equal_to: 0 }
  validates :device_id, uniqueness: { scope: :vault_id }
end
