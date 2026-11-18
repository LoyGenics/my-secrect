module Billing
  module DeletionGuard
    class ActiveBilling < StandardError; end
    module_function
    def check!(user:)
      # A mistaken environment switch must not orphan a real charge stored
      # under the other environment; its matching credentials are needed first.
      other_purchases = user.billing_purchases.where.not(environment: Config.environment)
      other_accounts = user.billing_accounts.where.not(environment: Config.environment)
      if other_purchases.any? { |p| p.option != 'lifetime' && p.blocks_checkout? && !p.cancel_at_period_end } ||
         BillingCheckout.where(billing_account_id: other_accounts.select(:id), status: %w[pending open processing]).exists?
        raise ActiveBilling
      end
      user.billing_accounts.where(environment: Config.environment).where.not(customer_id: nil).find_each do |account|
        StripeSync.reconcile!(account: account, gateway: StripeGateway.new)
        pending = account.billing_checkouts.where(status: %w[pending open processing]).exists?
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
