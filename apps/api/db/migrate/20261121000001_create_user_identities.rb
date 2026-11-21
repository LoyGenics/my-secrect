class CreateUserIdentities < ActiveRecord::Migration[7.1]
  def change
    create_table :user_identities, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.string :provider, null: false
      t.string :subject, null: false
      t.string :email, null: false
      t.timestamps
    end
    add_index :user_identities, %i[provider subject], unique: true
  end
end
