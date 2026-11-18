class CreateBilling < ActiveRecord::Migration[7.2]
  def change
    create_table :billing_accounts, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.string :environment, null: false
      t.string :customer_id
      t.timestamps
    end
    add_index :billing_accounts, %i[user_id environment], unique: true
    add_index :billing_accounts, %i[customer_id environment], unique: true

    create_table :billing_purchases, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.string :provider, null: false
      t.string :environment, null: false
      t.string :external_id, null: false
      t.string :option, null: false
      t.string :status, null: false
      t.string :risk_state
      t.datetime :expires_at
      t.boolean :cancel_at_period_end, null: false, default: false
      t.datetime :verified_at, null: false
      t.timestamps
    end
    add_index :billing_purchases, %i[provider environment external_id], unique: true, name: 'billing_purchase_identity'

    create_table :billing_checkouts, id: :uuid do |t|
      t.references :billing_account, null: false, type: :uuid, foreign_key: true
      t.string :option, null: false
      t.string :session_id
      t.string :status, null: false, default: 'pending'
      t.datetime :expires_at
      t.timestamps
    end
    add_index :billing_checkouts, :session_id, unique: true

    create_table :billing_events, id: :uuid do |t|
      t.string :provider, null: false
      t.string :environment, null: false
      t.string :external_id, null: false
      t.string :event_type, null: false
      t.timestamps
    end
    add_index :billing_events, %i[provider environment external_id], unique: true, name: 'billing_event_identity'
  end
end
