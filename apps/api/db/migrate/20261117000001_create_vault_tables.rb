# Logical schema from the architecture doc — add unique constraints, FKs,
# retention + authorization invariants before production.
# Server stores ONLY opaque ids, versions, ciphertext sizes and ciphertext.
class CreateVaultTables < ActiveRecord::Migration[7.1]
  def change
    create_table :users, id: :uuid do |t|
      t.string :email, null: false, index: { unique: true }
      t.string :status, null: false, default: 'active'
      t.timestamps
    end
    create_table :authenticators, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      t.string :credential_id, null: false, index: { unique: true }
      t.binary :public_key, null: false
      t.bigint :sign_count, null: false, default: 0
      t.datetime :revoked_at
      t.timestamps
    end
    create_table :devices, id: :uuid do |t|
      t.references :user, null: false, foreign_key: true, type: :uuid
      t.binary :public_key, null: false
      t.binary :name_encrypted # encrypted device name — server cannot read it
      t.datetime :last_seen_at
      t.datetime :revoked_at
      t.timestamps
    end
    create_table :vaults, id: :uuid do |t|
      t.references :owner, null: false, foreign_key: { to_table: :users }, type: :uuid
      t.integer :key_version, null: false, default: 1
      t.binary :encrypted_metadata
      t.timestamps
    end
    create_table :key_envelopes, id: :uuid do |t|
      t.references :vault, null: false, foreign_key: true, type: :uuid
      t.uuid :recipient_id, null: false # user or device id (opaque)
      t.integer :key_version, null: false
      t.binary :encrypted_key, null: false
      t.timestamps
    end
    create_table :items, id: :uuid do |t|
      t.references :vault, null: false, foreign_key: true, type: :uuid
      t.integer :current_revision, null: false, default: 0
      t.datetime :deleted_at
      t.timestamps
    end
    create_table :item_versions, id: :uuid do |t|
      t.references :item, null: false, foreign_key: true, type: :uuid
      t.integer :revision, null: false
      t.binary :encrypted_payload, null: false
      t.binary :encrypted_item_key, null: false
      t.integer :encryption_version, null: false, default: 1
      t.timestamps
      t.index %i[item_id revision], unique: true
    end
    create_table :sync_events, id: :uuid do |t|
      t.references :vault, null: false, foreign_key: true, type: :uuid
      t.bigint :sequence, null: false
      t.uuid :item_id, null: false
      t.integer :revision, null: false
      t.string :operation, null: false # upsert | delete
      t.references :device, foreign_key: true, type: :uuid
      t.binary :signature
      t.timestamps
      t.index %i[vault_id sequence], unique: true
    end
    create_table :blobs, id: :uuid do |t|
      t.references :vault, null: false, foreign_key: true, type: :uuid
      t.string :storage_key, null: false
      t.binary :encrypted_manifest # chunks, sizes, hashes, wrapped file key — encrypted
      t.bigint :ciphertext_size, null: false, default: 0
      t.string :status, null: false, default: 'pending'
      t.timestamps
    end
    create_table :blob_parts, id: :uuid do |t|
      t.references :blob, null: false, foreign_key: true, type: :uuid
      t.integer :part_number, null: false
      t.string :object_key, null: false
      t.bigint :ciphertext_size, null: false, default: 0
      t.timestamps
    end
    create_table :device_checkpoints, id: :uuid do |t|
      t.references :device, null: false, foreign_key: true, type: :uuid
      t.references :vault, null: false, foreign_key: true, type: :uuid
      t.bigint :last_sequence, null: false, default: 0
      t.binary :checkpoint_hash
      t.timestamps
    end
    create_table :audit_events, id: :uuid do |t|
      t.references :user, foreign_key: true, type: :uuid
      t.references :device, foreign_key: true, type: :uuid
      t.string :event_type, null: false
      t.timestamps
    end
  end
end
