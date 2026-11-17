class Item < ApplicationRecord
  belongs_to :vault
  has_many :item_versions, dependent: :destroy
  has_many :sync_events, foreign_key: :item_id, primary_key: :id, dependent: :nullify
  validates :current_revision, numericality: { greater_than_or_equal_to: 0 }
  scope :live, -> { where(deleted_at: nil) }
  def deleted? = deleted_at.present?
  def current_version = item_versions.find_by(revision: current_revision)
end
