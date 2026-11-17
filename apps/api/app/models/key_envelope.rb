class KeyEnvelope < ApplicationRecord
  belongs_to :vault
  validates :recipient_id, presence: true
  validates :key_version, numericality: { greater_than: 0 }
  validates :encrypted_key, presence: true
  validates :recipient_id, uniqueness: { scope: %i[vault_id key_version] }
end
