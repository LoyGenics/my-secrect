# Sharing v1 (specs/sharing-protocol.md): one X25519 identity key per user
# and end-to-end encrypted per-item shares. The server stores public keys,
# ciphertext and opaque ids only. The legacy `shares` table (vault-key
# envelopes that never went live) is untouched; nothing writes to it.
class CreateIdentityKeysAndItemShares < ActiveRecord::Migration[7.1]
  def change
    create_table :identity_keys, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid, index: { unique: true }
      t.binary :public_key, null: false
      t.binary :encrypted_secret_key, null: false
      t.timestamps
    end

    create_table :item_shares, id: :uuid do |t|
      t.references :owner, null: false, foreign_key: { to_table: :users }, type: :uuid
      t.references :recipient, null: false, foreign_key: { to_table: :users }, type: :uuid
      t.string :permission, null: false
      t.string :status, null: false, default: 'pending'
      t.datetime :expires_at
      t.binary :owner_public_key, null: false
      t.binary :recipient_public_key, null: false
      t.integer :revision, null: false, default: 1
      t.binary :encrypted_payload
      t.binary :encrypted_item_key
      t.binary :encrypted_owner_metadata
      t.uuid :last_writer_id
      t.datetime :accepted_at
      t.datetime :revoked_at
      t.timestamps
    end
  end
end
