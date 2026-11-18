module Billing
  module StripeEvents
    TYPES = %w[checkout.session.completed checkout.session.async_payment_succeeded checkout.session.async_payment_failed checkout.session.expired
      customer.subscription.created customer.subscription.updated customer.subscription.deleted invoice.paid invoice.payment_failed
      charge.refunded charge.dispute.created radar.early_fraud_warning.created].freeze
    module_function

    def call(event:, gateway: StripeGateway.new)
      return unless TYPES.include?(event['type'])
      return unless event['livemode'] == (Config.environment == 'live')
      object = event.fetch('data').fetch('object')
      customer_id = StripeSync.id(object['customer'])
      if event['type'] == 'charge.dispute.created' || event['type'] == 'radar.early_fraud_warning.created'
        customer_id = StripeSync.id(gateway.charge(StripeSync.id(object.fetch('charge')))['customer'])
      end
      account = BillingAccount.find_by(customer_id: customer_id, environment: Config.environment) if customer_id
      return unless account
      account.user.with_lock do
        key = { provider: 'stripe', environment: account.environment, external_id: event.fetch('id') }
        return if BillingEvent.exists?(key)
        StripeSync.reconcile!(account: account, gateway: gateway)
        if event['type'].start_with?('charge.', 'radar.')
          StripeSync.risk!(account: account, object: object, type: event['type'], gateway: gateway)
        end
        BillingEvent.create!(**key, event_type: event.fetch('type'))
      end
    end
  end
end
