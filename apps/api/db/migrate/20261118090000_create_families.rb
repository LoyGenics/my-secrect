class CreateFamilies < ActiveRecord::Migration[7.2]
  def change
    create_table :families, id: :uuid do |t|
      t.references :owner, null: false, type: :uuid, foreign_key: { to_table: :users }, index: { unique: true }
      t.timestamps
    end
    create_table :family_memberships, id: :uuid do |t|
      t.references :family, null: false, type: :uuid, foreign_key: true
      t.references :user, null: false, type: :uuid, foreign_key: true, index: { unique: true }
      t.string :status, null: false, default: 'pending'
      t.datetime :accepted_at
      t.datetime :expires_at
      t.timestamps
    end
    add_check_constraint :family_memberships, "status IN ('pending', 'active')", name: 'family_membership_status'
  end
end
