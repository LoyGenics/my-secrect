module Billing
  class StripeGateway
    def initialize
      key = ENV['STRIPE_API_KEY'].to_s
      mode = Config.environment
      unless key.match?(/\A[rs]k_#{mode}_/) && Config.stripe_ready?
        raise Config::Unavailable, 'billing_not_configured'
      end
      @client = Stripe::StripeClient.new(key)
    end

    def hash(object) = object.to_hash.deep_stringify_keys
    def price(id) = hash(@client.v1.prices.retrieve(id))
    def customer(key) = hash(@client.v1.customers.create({}, { idempotency_key: "mysecret-customer-#{key}" }))
    def session(id) = hash(@client.v1.checkout.sessions.retrieve(id))
    def subscription(id) = hash(@client.v1.subscriptions.retrieve(id))
    def invoice(id) = hash(@client.v1.invoices.retrieve(id))
    def charge(id) = hash(@client.v1.charges.retrieve(id))
    def payment_intent(id) = hash(@client.v1.payment_intents.retrieve(id, { expand: ['latest_charge'] }))
    def line_items(id) = @client.v1.checkout.sessions.list_line_items(id, { limit: 100 }).auto_paging_each.map { |v| hash(v) }
    def subscriptions(customer_id)
      @client.v1.subscriptions.list({ customer: customer_id, status: 'all', limit: 100 }).auto_paging_each.map { |v| hash(v) }
    end
    def invoice_payments(payment_intent)
      @client.v1.invoice_payments.list({ payment: { type: 'payment_intent', payment_intent: payment_intent }, status: 'paid', limit: 100 }).auto_paging_each.map { |v| hash(v) }
    end
    def create_session(params, key)
      hash(@client.v1.checkout.sessions.create(params, { idempotency_key: "mysecret-checkout-#{key}" }))
    end
    def portal(customer_id)
      params = { customer: customer_id, return_url: "#{Config.web_url}/?billing=return" }
      params[:configuration] = ENV['STRIPE_PORTAL_CONFIGURATION'] if ENV['STRIPE_PORTAL_CONFIGURATION'].present?
      hash(@client.v1.billing_portal.sessions.create(params))
    end

    def catalog
      Config.prices.map do |option, id|
        next { option: option, available: false } unless id
        value = price(id)
        recurring = value['recurring']
        valid = value['active'] && value['livemode'] == (Config.environment == 'live') &&
                value['unit_amount'].is_a?(Integer) && value['unit_amount'].positive? &&
                (option == 'lifetime' ? value['type'] == 'one_time' :
                  recurring && recurring['interval'] == (option == 'monthly' ? 'month' : 'year') && recurring['interval_count'] == 1)
        raise Config::Unavailable, 'invalid_billing_price' unless valid
        { option: option, available: true, amount: value['unit_amount'], currency: value['currency'] }
      end
    end
  end
end
