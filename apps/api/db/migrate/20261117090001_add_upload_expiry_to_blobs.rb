# Upload sessions expire (Blobs::UploadSession::UPLOAD_SESSION_TTL); the
# cleanup job finds expired ones by (status, upload_expires_at). Rows from
# before this migration have no expiry and are treated as expiring at
# created_at + TTL. One row per (blob, part_number).
class AddUploadExpiryToBlobs < ActiveRecord::Migration[7.1]
  def change
    add_column :blobs, :upload_expires_at, :datetime
    add_index :blobs, %i[status upload_expires_at]
    add_index :blob_parts, %i[blob_id part_number], unique: true
  end
end
