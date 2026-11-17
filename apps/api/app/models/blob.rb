class Blob < ApplicationRecord
  belongs_to :vault
  has_many :blob_parts, dependent: :destroy
  validates :storage_key, presence: true, uniqueness: true
  validates :status, inclusion: { in: %w[pending uploading complete failed orphaned] }
  validates :ciphertext_size, numericality: { greater_than_or_equal_to: 0 }
end
