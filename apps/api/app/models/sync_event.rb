class SyncEvent < ApplicationRecord
  belongs_to :vault
  belongs_to :device, optional: true
  validates :sequence, numericality: { greater_than: 0 }, uniqueness: { scope: :vault_id }
  validates :item_id, :revision, presence: true
  validates :operation, inclusion: { in: %w[upsert delete] }
end
