module Api
  module V1
    class BillingController < ApplicationController
      rescue_from Billing::Config::Unavailable, Stripe::StripeError, with: :billing_unavailable
      rescue_from Billing::Checkout::Conflict, with: :billing_conflict

      def show
        response.headers['Cache-Control'] = 'no-store'
        catalog = if Billing::Config.stripe_ready?
          Billing::StripeGateway.new.catalog
        else
          %w[monthly yearly lifetime].map { |option| { option: option, available: false } }
        end
        render json: Billing::Access.summary(user: current_user).merge(
          environment: Billing::Config.environment, catalog: catalog, stores_ready: Billing::RevenueCat.ready?,
          app_user_id: current_user.id,
          portal_available: current_user.billing_accounts.where(environment: Billing::Config.environment).where.not(customer_id: nil).exists?)
      end

      def access
        response.headers['Cache-Control'] = 'no-store'
        catalogue = current_session.recovery_session? ? {} : Billing::RevenueCat.store_products
        render json: Billing::Access.summary(user: current_user).merge(
          app_user_id: current_user.id, environment: Billing::Config.environment,
          store_products: catalogue)
      end

      def refresh_store
        return head :forbidden if current_session.recovery_session?
        raise Billing::Config::Unavailable unless Billing::RevenueCat.ready?

        current_user.with_lock { Billing::RevenueCat.new.reconcile!(user: current_user) }
        access
      end

      def checkout
        render json: { url: Billing::Checkout.call(user: current_user, option: params[:option].to_s) }
      rescue ArgumentError
        render json: { error: 'invalid_purchase_option' }, status: :unprocessable_entity
      end

      def portal
        account = current_user.billing_accounts.find_by!(environment: Billing::Config.environment)
        raise Billing::Config::Unavailable unless account.customer_id
        render json: { url: Billing::StripeGateway.new.portal(account.customer_id).fetch('url') }
      end

      def refresh
        current_user.with_lock do
          account = current_user.billing_accounts.find_by(environment: Billing::Config.environment)
          Billing::StripeSync.reconcile!(account: account, gateway: Billing::StripeGateway.new) if account&.customer_id
          Billing::RevenueCat.new.reconcile!(user: current_user) if Billing::RevenueCat.ready?
        end
        show
      end

      private
      def billing_unavailable
        render json: { error: 'billing_unavailable' }, status: :service_unavailable
      end
      def billing_conflict(error)
        render json: { error: error.message }, status: :conflict
      end
    end
  end
end
