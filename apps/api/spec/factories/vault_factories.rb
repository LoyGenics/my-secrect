FactoryBot.define do
  factory :user do
    sequence(:email) { |n| "user#{n}@example.test" }
    status { 'active' }
  end
  factory :device do
    user
    public_key { 'device-public-key-bytes' }
    last_seen_at { Time.current }
  end
  factory :vault do
    association :owner, factory: :user
    key_version { 1 }
    encrypted_metadata { 'opaque-encrypted-metadata' }
  end
  factory :item do
    vault
    current_revision { 0 }
  end
end
