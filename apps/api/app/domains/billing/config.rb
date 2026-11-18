module Billing
  module Config
    class Unavailable < StandardError; end
    module_function

    def environment
      value = ENV.fetch('BILLING_ENVIRONMENT', 'test')
      raise Unavailable, 'invalid_billing_environment' unless %w[test live].include?(value)
      value
    end

    def prices
      %w[monthly yearly lifetime].to_h { |option| [option, ENV["STRIPE_PRICE_#{option.upcase}"].presence] }
    end

    def stripe_ready?
      ENV['STRIPE_API_KEY'].present? && ENV['STRIPE_WEBHOOK_SECRET'].present? && ENV['BILLING_WEB_URL'].present?
    end

    def web_url
      url = ENV.fetch('BILLING_WEB_URL', '')
      uri = URI.parse(url)
      local = %w[localhost 127.0.0.1].include?(uri.host)
      unless uri.host && !uri.userinfo && !uri.query && !uri.fragment &&
             (uri.scheme == 'https' || (environment == 'test' && uri.scheme == 'http' && local))
        raise Unavailable, 'invalid_billing_web_url'
      end
      url.delete_suffix('/')
    rescue URI::InvalidURIError
      raise Unavailable, 'invalid_billing_web_url'
    end
  end
end
