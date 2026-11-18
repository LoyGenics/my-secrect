module Billing
  module Checkout
    class Conflict < StandardError; end
    module_function

    def call(user:, option:, gateway: StripeGateway.new)
      raise ArgumentError, 'invalid_purchase_option' unless Config.prices.key?(option)
      price_id = Config.prices[option]
      raise Config::Unavailable, 'price_not_configured' unless price_id
      # Persist ownership before any provider call. A failed request never loses
      # the idempotency identity for customer creation.
      account = user.billing_accounts.create_or_find_by!(environment: Config.environment)
      result = user.with_lock do
        begin
          account.reload
          if account.customer_id.nil?
            account.update!(customer_id: gateway.customer(account.id).fetch('id'))
          end
          StripeSync.subscriptions!(account: account, gateway: gateway)
          raise Conflict, 'existing_purchase' if Access.purchases(user: user).any?(&:blocks_checkout?)
          open = account.billing_checkouts.where(status: %w[pending open complete]).order(created_at: :desc).first
          if open&.session_id
            session = gateway.session(open.session_id)
            StripeSync.checkout!(account: account, session: session, gateway: gateway)
            raise Conflict, 'payment_processing' if session['status'] == 'complete'
            if session['status'] == 'open'
              raise Conflict, 'checkout_in_progress' if open.option != option
              next session.fetch('url')
            end
          end
          # An unsent/ambiguous API request reuses the durable row and key.
          open = nil if open && open.status != 'pending'
          raise Conflict, 'checkout_in_progress' if open && open.option != option
          open ||= account.billing_checkouts.create!(option: option)
          gateway.catalog # Validate server-owned Price type, currency and mode.
          params = {
            mode: option == 'lifetime' ? 'payment' : 'subscription', customer: account.customer_id,
            line_items: [{ price: price_id, quantity: 1 }],
            success_url: "#{Config.web_url}/?billing=success", cancel_url: "#{Config.web_url}/?billing=cancel",
            integration_identifier: 'my_secret_web_qmdptxza'
          }
          params[:subscription_data] = { billing_mode: { type: 'flexible' } } unless option == 'lifetime'
          session = gateway.create_session(params, open.id)
          open.update!(session_id: session.fetch('id'), status: session.fetch('status'), expires_at: Time.at(session.fetch('expires_at')))
          session.fetch('url')
        rescue Stripe::StripeError, Conflict, Config::Unavailable => error
          # Commit the pending checkout identity even on a network timeout, so
          # retrying cannot create a second chargeable Checkout Session.
          error
        end
      end
      raise result if result.is_a?(Exception)
      result
    end
  end
end
