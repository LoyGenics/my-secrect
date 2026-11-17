class OrphanBlobCleanupJob < ApplicationJob
  queue_as :low
  # Blobs stuck in 'uploading' for > 24h, or 'pending' with no parts,
  # are deleted from storage + DB. Runs nightly. Never decrypts anything.
  def perform
    Blob.where(status: %w[pending uploading]).where('created_at < ?', 24.hours.ago).find_each do |blob|
      provider = Blobs::StorageProvider.new
      blob.blob_parts.each { |p| provider.delete(object_key: p.object_key) } # raises on failure: job retries, rows kept
      blob.update!(status: 'orphaned')
      blob.destroy!
    end
  end
end
