module Billing
  module DeletionGuard
    class ActiveBilling < StandardError; end
    module_function
    def check!(user:)
      user.billing_accounts.where(environment: Config.environment).where.not(customer_id: nil).find_each do |account|
        StripeSync.reconcile!(account: account, gateway: StripeGateway.new)
        pending = account.billing_checkouts.where(status: %w[pending open]).exists?
        raise ActiveBilling if pending
      end
      RevenueCat.new.reconcile!(user: user) if RevenueCat.ready? && user.billing_purchases.where(provider: %w[app_store google_play]).exists?
      recurring = Access.purchases(user: user).where.not(option: 'lifetime').any? do |purchase|
        purchase.blocks_checkout? && !purchase.cancel_at_period_end
      end
      raise ActiveBilling if recurring
    end
  end
end
