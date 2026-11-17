module Billing
  # Quotas are enforced on ciphertext sizes only — the server never inspects
  # content. v1 defaults: 5 GiB storage, 10_000 items per user (self-host can raise).
  module Quota
    STORAGE_LIMIT_BYTES = ENV.fetch('QUOTA_STORAGE_BYTES', 5 * 1024 * 1024 * 1024).to_i
    ITEM_LIMIT = ENV.fetch('QUOTA_ITEMS', 10_000).to_i
    module_function
    def usage_for(user:) = { storage_bytes: user.blobs.sum(:ciphertext_size), item_count: Item.joins(:vault).where(vaults: { owner_id: user.id }).count }
    def over_storage_limit?(user:) = usage_for(user: user)[:storage_bytes] > STORAGE_LIMIT_BYTES
    def over_item_limit?(user:) = usage_for(user: user)[:item_count] > ITEM_LIMIT
  end
end
