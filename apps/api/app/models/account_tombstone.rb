# Record that an account was deleted: hashed user id + time, nothing else.
# See Accounts::Tombstones.
class AccountTombstone < ApplicationRecord
  validates :user_id_digest, presence: true, uniqueness: true, format: { with: /\A\h{64}\z/ }
  validates :deleted_at, presence: true
end
