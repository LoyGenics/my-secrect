require 'net/http'

module Billing
  # Store receipt verification belongs to RevenueCat; this adapter fetches an
  # authoritative snapshot. Neither mobile clients nor webhook payload fields
  # can grant access directly. Stripe purchases are deliberately excluded.
  class RevenueCat
    STORES = { 'app_store' => 'app_store', 'play_store' => 'google_play' }.freeze
    def self.ready? = ENV['REVENUECAT_SECRET_API_KEY'].present? && ENV['REVENUECAT_PRODUCTS'].present?

    def fetch_subscriber(user_id)
      raise Config::Unavailable, 'store_billing_not_configured' unless self.class.ready?
      uri = URI("https://api.revenuecat.com/v1/subscribers/#{ERB::Util.url_encode(user_id)}")
      req = Net::HTTP::Get.new(uri)
      req['Authorization'] = "Bearer #{ENV.fetch('REVENUECAT_SECRET_API_KEY')}"
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 15) { |http| http.request(req) }
      raise Config::Unavailable, 'store_billing_unavailable' unless response.is_a?(Net::HTTPSuccess)
      JSON.parse(response.body).fetch('subscriber')
    rescue JSON::ParserError, KeyError, Timeout::Error, SocketError, IOError, SystemCallError
      raise Config::Unavailable, 'store_billing_unavailable'
    end

    def reconcile!(user:)
      # Caller holds the account lock, including during the provider read, to
      # serialize old deliveries, restore and purchase completion.
      subscriber = fetch_subscriber(user.id)
      products = JSON.parse(ENV.fetch('REVENUECAT_PRODUCTS'))
      seen = []
      (subscriber['subscriptions'] || {}).each do |product_id, value|
        provider = STORES[value['store']]
        option = products.dig(provider, product_id) if provider
        next unless %w[monthly yearly].include?(option) && matching_environment?(value)
        expires = timestamp(value['grace_period_expires_date']) || timestamp(value['expires_date'])
        next unless expires
        status = value['refunded_at'] ? 'refunded' : expires > Time.current ? 'active' : 'expired'
        status = 'grace_period' if status == 'active' && value['grace_period_expires_date']
        seen << upsert!(user: user, provider: provider, external_id: "subscription:#{user.id}:#{product_id}",
          option: option, status: status, expires_at: expires, cancel: value['unsubscribe_detected_at'].present?).id
      end
      (subscriber['non_subscriptions'] || {}).each do |product_id, values|
        values.each do |value|
          provider = STORES[value['store']]
          next unless provider && products.dig(provider, product_id) == 'lifetime' && matching_environment?(value)
          transaction = value['store_transaction_id'] || value['id']
          next unless transaction.present?
          seen << upsert!(user: user, provider: provider, external_id: "purchase:#{transaction}", option: 'lifetime',
            status: value['refunded_at'] ? 'refunded' : 'active', expires_at: nil, cancel: false).id
        end
      end
      # A removed/refunded/transferred purchase disappears from the snapshot.
      user.billing_purchases.where(provider: STORES.values, environment: Config.environment).where.not(id: seen)
        .update_all(status: 'expired', verified_at: Time.current, updated_at: Time.current)
    rescue JSON::ParserError, TypeError, ArgumentError
      raise Config::Unavailable, 'invalid_store_billing_configuration'
    end

    private
    def matching_environment?(value)
      value['is_sandbox'] == (Config.environment == 'test')
    end
    def timestamp(value) = value.present? ? Time.iso8601(value) : nil
    def upsert!(user:, provider:, external_id:, option:, status:, expires_at:, cancel:)
      purchase = BillingPurchase.find_or_initialize_by(provider: provider, environment: Config.environment, external_id: external_id)
      # Never silently move a lifetime purchase to another account on restore.
      raise Checkout::Conflict, 'purchase_owner_mismatch' if purchase.persisted? && purchase.user_id != user.id
      purchase.update!(user: user, option: option, status: status, expires_at: expires_at,
        cancel_at_period_end: cancel, verified_at: Time.current)
      purchase
    end
  end
end
