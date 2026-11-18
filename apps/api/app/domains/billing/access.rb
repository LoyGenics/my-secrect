module Billing
  module Access
    module_function
    def purchases(user:)
      user.billing_purchases.where(environment: Config.environment).order(created_at: :desc)
    end

    def summary(user:)
      records = purchases(user: user).to_a
      grants = records.select(&:entitled?)
      lifetime = grants.any? { |purchase| purchase.option == 'lifetime' }
      {
        tier: grants.any? ? 'pro' : 'free', lifetime: lifetime,
        expires_at: lifetime ? nil : grants.filter_map(&:expires_at).max,
        checkout_blocked: records.any?(&:blocks_checkout?),
        purchases: records.map { |p| {
          id: p.id, provider: p.provider, option: p.option, status: p.status,
          entitled: p.entitled?, expires_at: p.expires_at,
          cancel_at_period_end: p.cancel_at_period_end, review_required: p.risk_state.present?,
          verified_at: p.verified_at
        } }
      }
    end
  end
end
