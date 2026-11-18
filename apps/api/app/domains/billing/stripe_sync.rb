module Billing
  module StripeSync
    module_function
    def id(value) = value.is_a?(Hash) ? value['id'] : value

    def subscriptions!(account:, gateway:)
      gateway.subscriptions(account.customer_id).each { |sub| subscription!(account: account, sub: sub) }
    end

    def subscription!(account:, sub:)
      return unless id(sub['customer']) == account.customer_id && sub['livemode'] == (account.environment == 'live')
      items = sub.dig('items', 'data') || []
      return unless items.size == 1
      item = items.first
      option = Config.prices.key(id(item['price']))
      return unless %w[monthly yearly].include?(option)
      purchase = BillingPurchase.find_or_initialize_by(provider: 'stripe', environment: account.environment, external_id: sub.fetch('id'))
      raise Checkout::Conflict, 'purchase_owner_mismatch' if purchase.persisted? && purchase.user_id != account.user_id
      purchase.assign_attributes(user: account.user, option: option, status: sub.fetch('status'),
        expires_at: item['current_period_end'] && Time.at(item['current_period_end']),
        cancel_at_period_end: sub['cancel_at_period_end'] == true, verified_at: Time.current)
      purchase.save!
    end

    def checkout!(account:, session:, gateway:)
      return unless id(session['customer']) == account.customer_id && session['livemode'] == (account.environment == 'live')
      checkout = account.billing_checkouts.find_by(session_id: session.fetch('id'))
      return unless checkout
      checkout.update!(status: session.fetch('status'))
      return unless checkout.option == 'lifetime' && session['status'] == 'complete' && session['payment_status'] == 'paid'
      items = gateway.line_items(session.fetch('id'))
      return unless items.size == 1 && id(items.first['price']) == Config.prices['lifetime'] && items.first['quantity'] == 1
      intent = gateway.payment_intent(id(session['payment_intent']))
      return unless intent['status'] == 'succeeded'
      charge = intent['latest_charge']
      charge = gateway.charge(charge) unless charge.is_a?(Hash)
      risk = charge['disputed'] ? 'disputed' : charge['amount_refunded'].to_i.positive? ? 'refunded' : nil
      purchase = account.user.billing_purchases.find_or_initialize_by(provider: 'stripe', environment: account.environment, external_id: session.fetch('id'))
      # A later success delivery must not clear an earlier risk decision.
      purchase.update!(option: 'lifetime', status: 'active', expires_at: nil,
        risk_state: risk || purchase.risk_state, cancel_at_period_end: false, verified_at: Time.current)
    end

    def risk!(account:, object:, type:, gateway:)
      charge = type == 'charge.refunded' ? gateway.charge(object.fetch('id')) : gateway.charge(id(object.fetch('charge')))
      return unless id(charge['customer']) == account.customer_id
      intent = id(charge['payment_intent'])
      return unless intent
      affected = []
      account.billing_checkouts.where(option: 'lifetime').where.not(session_id: nil).find_each do |checkout|
        session = gateway.session(checkout.session_id)
        affected << checkout.session_id if id(session['payment_intent']) == intent
      end
      gateway.invoice_payments(intent).each do |payment|
        invoice = gateway.invoice(id(payment['invoice']))
        next unless id(invoice['customer']) == account.customer_id && invoice.dig('parent', 'type') == 'subscription_details'
        affected << id(invoice.dig('parent', 'subscription_details', 'subscription'))
      end
      state = type == 'charge.refunded' ? 'refunded' : type.start_with?('charge.dispute') ? 'disputed' : 'fraud_review'
      return if type == 'charge.refunded' && charge['amount_refunded'].to_i.zero?
      account.user.billing_purchases.where(provider: 'stripe', environment: account.environment, external_id: affected.compact)
        .update_all(risk_state: state, verified_at: Time.current, updated_at: Time.current)
    end

    def reconcile!(account:, gateway:)
      subscriptions!(account: account, gateway: gateway)
      account.billing_checkouts.where(status: %w[pending open complete]).where.not(session_id: nil).find_each do |checkout|
        checkout!(account: account, session: gateway.session(checkout.session_id), gateway: gateway)
      end
    end
  end
end
