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
      purchase = BillingPurchase.find_or_initialize_by(provider: 'stripe', environment: account.environment, external_id: sub.fetch('id'))
      raise Checkout::Conflict, 'purchase_owner_mismatch' if purchase.persisted? && purchase.user_id != account.user_id
      price_id = id(item['price'])
      option = Config.prices.key(price_id)
      # Retired prices remain valid for already-bound subscriptions, including
      # renewals/cancellation, but cannot authorize a new unknown subscription.
      option ||= purchase.option if purchase.persisted? && purchase.price_id == price_id
      option ||= account.billing_checkouts.where(price_id: price_id, option: %w[monthly yearly]).pick(:option)
      return unless %w[monthly yearly].include?(option)
      purchase.assign_attributes(user: account.user, option: option, status: sub.fetch('status'),
        price_id: price_id,
        expires_at: item['current_period_end'] && Time.at(item['current_period_end']),
        cancel_at_period_end: sub['cancel_at_period_end'] == true, verified_at: Time.current)
      purchase.save!
    end

    def checkout!(account:, session:, gateway:)
      return unless id(session['customer']) == account.customer_id && session['livemode'] == (account.environment == 'live')
      checkout = account.billing_checkouts.find_by(session_id: session.fetch('id'))
      return unless checkout
      status = session.fetch('status')
      if status == 'complete' && session['payment_status'] == 'unpaid'
        intent_id = id(session['payment_intent'])
        intent_status = gateway.payment_intent(intent_id)['status'] if intent_id
        status = %w[canceled requires_payment_method].include?(intent_status) ? 'failed' : 'processing'
      end
      checkout.update!(status: status)
      return unless checkout.option == 'lifetime' && session['status'] == 'complete' && session['payment_status'] == 'paid'
      items = gateway.line_items(session.fetch('id'))
      return unless items.size == 1 && id(items.first['price']) == (checkout.price_id || Config.prices['lifetime']) && items.first['quantity'] == 1
      intent = gateway.payment_intent(id(session['payment_intent']))
      return unless intent['status'] == 'succeeded'
      charge = intent['latest_charge']
      charge = gateway.charge(charge) unless charge.is_a?(Hash)
      risk = charge['disputed'] ? 'disputed' : charge['amount_refunded'].to_i.positive? ? 'refunded' : nil
      purchase = account.user.billing_purchases.find_or_initialize_by(provider: 'stripe', environment: account.environment, external_id: session.fetch('id'))
      # A later success delivery must not clear an earlier risk decision.
      purchase.update!(option: 'lifetime', status: 'active', expires_at: nil,
        price_id: id(items.first['price']),
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
      account.billing_checkouts.where(status: %w[pending open processing complete]).where.not(session_id: nil).find_each do |checkout|
        checkout!(account: account, session: gateway.session(checkout.session_id), gateway: gateway)
      end
    end
  end
end
