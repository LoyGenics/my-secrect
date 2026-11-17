class QuotaCheckJob < ApplicationJob
  queue_as :low
  # Flags users over quota (storage/items). Enforcement happens at upload
  # time via Billing::Quota; this job is for reporting + cleanup warnings.
  def perform(user_id)
    user = User.find_by(id: user_id)
    return unless user
    usage = Billing::Quota.usage_for(user: user)
    Audit::Log.call(user: user, event_type: 'quota_exceeded') if Billing::Quota.over_storage_limit?(user: user) || Billing::Quota.over_item_limit?(user: user)
    usage
  end
end
