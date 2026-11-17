class Share < ApplicationRecord
  belongs_to :vault
  belongs_to :owner, class_name: 'User'
  belongs_to :recipient, class_name: 'User', optional: true
  validates :permission, inclusion: { in: %w[read write] }
  validates :status, inclusion: { in: %w[pending active revoked] }
  validates :vault_id, uniqueness: { scope: :recipient_id, message: 'already shared with this recipient' }
end
