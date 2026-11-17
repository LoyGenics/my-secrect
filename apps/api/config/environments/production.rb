require 'active_support/core_ext/integer/time'

# Fail at boot instead of running with a missing, placeholder or weak secret.
# Messages name the variable, never its value. Object storage (S3_*) is
# validated separately in config/initializers/storage_config.rb.
required = %w[SECRET_KEY_BASE DATABASE_URL REDIS_URL WEBAUTHN_RP_ID WEBAUTHN_ORIGIN CORS_ORIGINS]
missing = required.select { |name| ENV[name].to_s.strip.empty? }
raise "Missing required environment variables: #{missing.join(', ')}" if missing.any?

placeholders = %w[SECRET_KEY_BASE DATABASE_URL S3_ACCESS_KEY S3_SECRET_KEY].select { |name| ENV[name].to_s.match?(/change_?me/i) }
raise "Placeholder value (CHANGE_ME) in: #{placeholders.join(', ')}" if placeholders.any?
raise 'SECRET_KEY_BASE must be at least 64 characters (openssl rand -hex 64)' if ENV['SECRET_KEY_BASE'].length < 64
raise 'S3_SECRET_KEY must be at least 16 characters' if ENV['S3_SECRET_KEY'].to_s.length.between?(1, 15)
raise 'CORS_ORIGINS must list exact origins, never *' if ENV['CORS_ORIGINS'].split(',').map(&:strip).any? { |o| o.empty? || o.include?('*') }

Rails.application.configure do
  config.cache_classes = true
  config.eager_load = true
  config.consider_all_requests_local = false
  config.public_file_server.enabled = false
  config.log_level = :info
  # Containers log to stdout (docker logs). One JSON line per request comes
  # from config/initializers/logging.rb; see that file for what is
  # (and is never) logged.
  $stdout.sync = true
  config.logger = ActiveSupport::TaggedLogging.new(ActiveSupport::Logger.new($stdout))
  # Exceptions Rails maps to 4xx (bad JSON, unknown route, record not found)
  # are not logged with their message: a JSON parse error message quotes the
  # request body. The request line still records the status.
  config.action_dispatch.log_rescued_responses = false
  config.active_record.dump_schema_after_migration = false
  config.force_ssl = true
  # Background jobs run in the separate `worker` (sidekiq) container.
  config.active_job.queue_adapter = :sidekiq
  # Never log ciphertext or key material, even at debug level.
  config.filter_parameters += %i[encrypted_payload encrypted_item_key encrypted_key signature]
end
