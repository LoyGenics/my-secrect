class Vault < ApplicationRecord
  belongs_to :owner, class_name: 'User'
  has_many :key_envelopes, dependent: :destroy
  has_many :items, dependent: :destroy
  has_many :sync_events, dependent: :destroy
  has_many :blobs, dependent: :destroy
  has_many :shares, dependent: :destroy
  has_many :device_checkpoints, dependent: :destroy
  validates :key_version, numericality: { greater_than: 0 }
end
