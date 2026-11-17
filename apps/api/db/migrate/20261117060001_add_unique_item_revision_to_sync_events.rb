# One sync event per item revision. Every accepted write bumps the item's
# revision by exactly one and appends exactly one event, so a second event
# for the same (item_id, revision) can only come from a duplicated write.
# The database refuses it (backstop for EncryptedRecords::AppendEvent).
class AddUniqueItemRevisionToSyncEvents < ActiveRecord::Migration[7.1]
  def change
    add_index :sync_events, %i[item_id revision], unique: true
  end
end
