class AddBillingPriceIdentity < ActiveRecord::Migration[7.2]
  def change
    add_column :billing_checkouts, :price_id, :string
    add_column :billing_purchases, :price_id, :string
  end
end
