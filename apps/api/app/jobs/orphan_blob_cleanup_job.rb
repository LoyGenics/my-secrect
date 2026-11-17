class OrphanBlobCleanupJob < ApplicationJob
  queue_as :low
  # Never decrypts anything. Two sweeps:
  #  1. Expired upload sessions (pending/uploading/failed past their upload
  #     expiry): every object under the blob's prefix is deleted from
  #     storage, then the rows. A storage error raises — the job retries and
  #     the rows stay, so the objects stay referenced.
  #  2. Orphan objects: any vaults/<vault>/blobs/<blob>/... object whose
  #     blob row no longer exists (e.g. a PUT that landed after its session
  #     was cleaned up — a presigned URL stays valid PRESIGN_TTL) and that
  #     is older than PRESIGN_TTL. Keys outside that layout are left alone.
  # The app does not schedule this job: run `bin/rails blobs:cleanup`
  # periodically (cron / systemd timer / scheduler of the deployment).
  ABANDONED = %w[pending uploading failed].freeze
  BLOB_KEY = %r{\Avaults/[^/]+/blobs/(\h{8}-\h{4}-\h{4}-\h{4}-\h{12})/}

  def perform
    provider = Blobs.storage_provider
    now = Time.current
    expired = expired_sessions(now).to_a
    deleted = expired.sum { |blob| delete_blob(provider, blob) }
    orphans = orphan_objects(provider, now)
    orphans.each { |o| provider.delete(object_key: o.key) }
    { expired_blobs: expired.size, deleted_objects: deleted, orphan_objects: orphans.size }
  end

  private

  def expired_sessions(now)
    legacy_cutoff = now - Blobs::UploadSession::UPLOAD_SESSION_TTL
    Blob.where(status: ABANDONED, upload_expires_at: ..now)
        .or(Blob.where(status: ABANDONED, upload_expires_at: nil, created_at: ..legacy_cutoff))
  end

  def delete_blob(provider, blob)
    keys = provider.list(prefix: "#{blob.storage_key}/").map(&:key) | blob.blob_parts.pluck(:object_key)
    keys.each { |key| provider.delete(object_key: key) }
    blob.destroy!
    keys.size
  end

  def orphan_objects(provider, now)
    settled = now - Blobs::StorageProvider::PRESIGN_TTL
    candidates = provider.list(prefix: 'vaults/').select { |o| o.last_modified <= settled && o.key.match?(BLOB_KEY) }
    ids = candidates.map { |o| o.key[BLOB_KEY, 1] }.uniq
    live = ids.each_slice(1_000).flat_map { |slice| Blob.where(id: slice).pluck(:id) }.to_set
    candidates.reject { |o| live.include?(o.key[BLOB_KEY, 1]) }
  end
end
