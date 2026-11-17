# A deleted account leaves a tombstone so the deletion can be re-applied
# after a backup restore brings the account back (Accounts::Tombstones).
# No PII: only a salted hash of the opaque user id and the time.
class CreateAccountTombstones < ActiveRecord::Migration[7.1]
  def change
    create_table :account_tombstones, id: :uuid do |t|
      t.string :user_id_digest, null: false
      t.datetime :deleted_at, null: false
      t.timestamps
      t.index :user_id_digest, unique: true
    end
  end
end
