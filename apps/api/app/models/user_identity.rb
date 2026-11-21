# A Google or Apple account linked to a user: the provider's stable
# subject id and the verified email it presented when it was linked.
class UserIdentity < ApplicationRecord
  PROVIDERS = %w[google apple].freeze

  belongs_to :user
  validates :provider, inclusion: { in: PROVIDERS }
  validates :subject, :email, presence: true
end
