# One end-to-end encrypted item shared by `owner` with `recipient`
# (specs/sharing-protocol.md §5). The row holds the CURRENT revision only:
# encrypted_payload + encrypted_item_key (the per-revision Share Key boxed
# for the pair). Revocation erases the ciphertext columns.
class ItemShare < ApplicationRecord
  PERMISSIONS = %w[read write].freeze
  STATUSES = %w[pending active revoked].freeze

  belongs_to :owner, class_name: 'User'
  belongs_to :recipient, class_name: 'User'

  validates :permission, inclusion: { in: PERMISSIONS }
  validates :status, inclusion: { in: STATUSES }
  validates :revision, numericality: { greater_than: 0 }
  validates :owner_public_key, :recipient_public_key, presence: true
  validates :encrypted_payload, :encrypted_item_key, :encrypted_owner_metadata, :last_writer_id,
            presence: true, unless: :revoked?
  validate :owner_is_not_recipient

  scope :for_party, ->(user) { where(owner_id: user.id).or(where(recipient_id: user.id)) }

  def pending? = status == 'pending'
  def active? = status == 'active'
  def revoked? = status == 'revoked'
  def writable? = permission == 'write'
  def expired?(now = Time.current) = expires_at.present? && expires_at <= now
  def owner?(user) = owner_id == user.id
  def recipient?(user) = recipient_id == user.id

  private

  def owner_is_not_recipient
    errors.add(:recipient_id, 'cannot be the owner') if owner_id.present? && owner_id == recipient_id
  end
end
