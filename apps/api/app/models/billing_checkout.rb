class BillingCheckout < ApplicationRecord
  belongs_to :billing_account
  validates :option, inclusion: { in: %w[monthly yearly lifetime] }
end
