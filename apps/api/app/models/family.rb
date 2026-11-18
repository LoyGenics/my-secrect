# A six-person account group. Membership grants no vault or key access.
class Family < ApplicationRecord
  LIMIT = 6
  belongs_to :owner, class_name: 'User'
  has_many :family_memberships, dependent: :destroy
  validates :owner_id, uniqueness: true
end
