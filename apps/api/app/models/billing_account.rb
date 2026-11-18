class BillingAccount < ApplicationRecord
  belongs_to :user
  has_many :billing_checkouts, dependent: :delete_all
  validates :environment, inclusion: { in: %w[test live] }
end
