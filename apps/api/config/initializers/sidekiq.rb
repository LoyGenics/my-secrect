Sidekiq.configure_server do |config|
  config.redis = { url: ENV.fetch('REDIS_URL', 'redis://localhost:6379/0') }
  # Jobs NEVER decrypt vault content: orphan cleanup, quota, retention only.
  config.queues = %w[default low]
  # Starts the hourly orphan-blob sweep (self-renewing; one chain across workers).
  config.on(:startup) { OrphanBlobCleanupJob.ensure_scheduled }
end
Sidekiq.configure_client do |config|
  config.redis = { url: ENV.fetch('REDIS_URL', 'redis://localhost:6379/0') }
end
