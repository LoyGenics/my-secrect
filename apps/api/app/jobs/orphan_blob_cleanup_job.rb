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
  #     is older than PRESIGN_TTL — this also catches a chunk PUT after its
  #     account was deleted. Keys outside that layout are left alone.
  #
  # Schedule: Sidekiq OSS has no cron, so the job keeps a self-renewing
  # chain. The Sidekiq server calls ensure_scheduled at boot
  # (config/initializers/sidekiq.rb). The first execution of every run
  # claims and enqueues the next run INTERVAL later BEFORE sweeping, so a
  # failing sweep (retried by ApplicationJob's retry_on) neither breaks the
  # chain nor, on retry, starts a second one. The claim is a Redis key set
  # with NX that expires after the next run is due: several worker
  # processes or restarts never run parallel chains, and if the chain is
  # ever lost (Redis flushed) the next worker boot restarts it.
  # Run it by hand: `bundle exec rake blobs:cleanup`.
  ABANDONED = %w[pending uploading failed].freeze
  BLOB_KEY = %r{\Avaults/[^/]+/blobs/(\h{8}-\h{4}-\h{4}-\h{4}-\h{12})/}
  INTERVAL = 1.hour
  FIRST_RUN_DELAY = 1.minute
  SCHEDULE_KEY = "my-secrect:#{Rails.env}:orphan_blob_cleanup:next_run".freeze

  def self.ensure_scheduled = schedule(wait: FIRST_RUN_DELAY)

  # Enqueue one run `wait` from now unless one is already pending. True when this call scheduled it.
  def self.schedule(wait:)
    claimed = Sidekiq.redis { |r| r.call('SET', SCHEDULE_KEY, (Time.current + wait).to_i.to_s, 'NX', 'EX', (wait + INTERVAL).to_i) }
    return false unless claimed

    set(wait: wait).perform_later
    true
  end

  def perform
    if executions == 1
      Sidekiq.redis { |r| r.call('DEL', SCHEDULE_KEY) }
      self.class.schedule(wait: INTERVAL)
    end
    provider = Blobs.storage_provider
    now = Time.current
    expired = expired_sessions(now).to_a
    deleted = expired.sum { |blob| delete_blob(provider, blob) }
    orphans = orphan_objects(provider, now)
    orphans.each { |o| provider.delete(object_key: o.key) }
    # deleted_keys: delete requests for expired sessions — every listed object plus every part key (S3 deletes are idempotent).
    { expired_blobs: expired.size, deleted_keys: deleted, orphan_objects: orphans.size }
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
