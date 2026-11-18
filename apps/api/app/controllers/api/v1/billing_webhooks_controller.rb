module Api
  module V1
    class BillingWebhooksController < ApplicationController
      skip_before_action :authenticate_request!

      def stripe
        secret = ENV['STRIPE_WEBHOOK_SECRET'].presence
        return head :service_unavailable unless secret
        return head :payload_too_large if request.raw_post.bytesize > 256.kilobytes
        event = Stripe::Webhook.construct_event(request.raw_post, request.headers['Stripe-Signature'], secret)
        Billing::StripeEvents.call(event: event.to_hash.deep_stringify_keys)
        head :ok
      rescue JSON::ParserError, Stripe::SignatureVerificationError
        head :bad_request
      rescue Billing::Config::Unavailable, Stripe::StripeError, Billing::Checkout::Conflict
        head :service_unavailable
      end

      def revenuecat
        secret = ENV['REVENUECAT_WEBHOOK_AUTHORIZATION'].presence
        return head :service_unavailable unless secret && Billing::RevenueCat.ready?
        return head :unauthorized unless ActiveSupport::SecurityUtils.secure_compare(request.headers['Authorization'].to_s, secret)
        return head :payload_too_large if request.raw_post.bytesize > 256.kilobytes
        event = JSON.parse(request.raw_post).fetch('event')
        return head :bad_request unless event['id'].is_a?(String) && event['type'].is_a?(String)
        expected = Billing::Config.environment == 'test' ? 'SANDBOX' : 'PRODUCTION'
        return head :ok unless event['environment'] == expected
        # Transfers are intentionally disabled in RevenueCat configuration.
        # Reject them for investigation instead of stealing another account's
        # purchase or acknowledging a partial multi-account update.
        return head :conflict if event['type'] == 'TRANSFER'
        user = User.find_by(id: event['app_user_id'])
        if user
          user.with_lock do
            key = { provider: 'revenuecat', environment: Billing::Config.environment, external_id: event['id'] }
            unless BillingEvent.exists?(key)
              Billing::RevenueCat.new.reconcile!(user: user)
              BillingEvent.create!(**key, event_type: event['type'])
            end
          end
        end
        head :ok
      rescue JSON::ParserError, KeyError
        head :bad_request
      rescue Billing::Config::Unavailable, Billing::Checkout::Conflict
        head :service_unavailable
      end
    end
  end
end
