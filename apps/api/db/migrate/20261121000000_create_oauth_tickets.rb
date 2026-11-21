class CreateOauthTickets < ActiveRecord::Migration[7.1]
  def change
    create_table :oauth_tickets, id: :uuid do |t|
      t.string :ticket_digest, null: false
      t.datetime :expires_at, null: false
      t.datetime :consumed_at
      t.timestamps
    end
    add_index :oauth_tickets, :ticket_digest, unique: true
    add_index :oauth_tickets, :expires_at
  end
end
