class BlobPart < ApplicationRecord
  belongs_to :blob
  validates :part_number, numericality: { greater_than: 0 }, uniqueness: { scope: :blob_id }
  validates :object_key, presence: true
  validates :ciphertext_size, numericality: { greater_than_or_equal_to: 0 }
end
