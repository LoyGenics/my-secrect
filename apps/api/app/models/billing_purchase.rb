class BillingPurchase < ApplicationRecord
  belongs_to :user
  validates :provider, inclusion: { in: %w[stripe app_store google_play] }
  validates :environment, inclusion: { in: %w[test live] }
  validates :option, inclusion: { in: %w[monthly yearly lifetime] }
  validates :external_id, :status, :verified_at, presence: true

  def entitled?(at: Time.current)
    return false if risk_state.present? || !%w[active trialing grace_period].include?(status)
    option == 'lifetime' ? expires_at.nil? : expires_at.present? && expires_at > at
  end

  # Includes subscriptions that can still charge, even when access has expired.
  def blocks_checkout?
    entitled? || (option != 'lifetime' && %w[active trialing grace_period past_due unpaid incomplete paused].include?(status))
  end
end
