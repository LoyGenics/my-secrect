class CreateShareLinks < ActiveRecord::Migration[7.1]
  def change
    create_table :share_links, id: :string do |t|
      t.references :owner, null: false, type: :uuid, foreign_key: { to_table: :users }
      t.integer :format_version, null: false, default: 1
      t.datetime :expires_at, null: false
      t.binary :encrypted_payload
      t.binary :encrypted_owner_metadata
      t.datetime :revoked_at
      t.timestamps
    end
    add_index :share_links, :expires_at
  end
end
