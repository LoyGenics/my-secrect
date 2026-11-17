class ItemVersion < ApplicationRecord
  belongs_to :item
  validates :revision, numericality: { greater_than: 0 }
  validates :revision, uniqueness: { scope: :item_id }
  validates :encrypted_payload, :encrypted_item_key, presence: true
  validates :encryption_version, numericality: { greater_than: 0 }
  # No plaintext is ever stored here — encrypted_payload is opaque bytes.
end
