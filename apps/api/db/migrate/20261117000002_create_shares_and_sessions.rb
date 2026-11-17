# Shares were in the architecture doc but missing from migration 001.
# Sessions are server-side hashed Bearer tokens (see Authentication::SessionTokens).
class CreateSharesAndSessions < ActiveRecord::Migration[7.1]
  def change
    create_table :shares, id: :uuid do |t|
      t.references :vault, null: false, foreign_key: true, type: :uuid
      t.references :owner, null: false, foreign_key: { to_table: :users }, type: :uuid
      t.references :recipient, foreign_key: { to_table: :users }, type: :uuid
      t.string :permission, null: false, default: 'read'
      t.string :status, null: false, default: 'pending'
      t.binary :encrypted_key
      t.timestamps
      t.index %i[vault_id recipient_id], unique: true
    end
    create_table :sessions, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      t.references :device, foreign_key: true, type: :uuid
      t.string :token_digest, null: false, index: { unique: true }
      t.datetime :expires_at, null: false
      t.datetime :revoked_at
      t.timestamps
    end
    create_table :passkey_challenges, id: :uuid do |t|
      t.string :email, null: false
      t.string :challenge, null: false
      t.string :kind, null: false, default: 'authentication'
      t.datetime :expires_at, null: false
      t.datetime :consumed_at
      t.timestamps
      t.index %i[email challenge], unique: true
    end
  end
end
