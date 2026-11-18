class FamilyMembership < ApplicationRecord
  belongs_to :family
  belongs_to :user
  validates :user_id, uniqueness: true
  validates :status, inclusion: { in: %w[pending active] }
  scope :live, -> { where(status: 'active').or(where(status: 'pending').where(expires_at: Time.current..)) }
  def pending? = status == 'pending'
  def active? = status == 'active'
  def expired? = pending? && (expires_at.nil? || expires_at <= Time.current)
end
