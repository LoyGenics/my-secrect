# Production must never boot with missing/blank/invalid object-storage
# configuration (no defaults exist). Validates only; builds no client and
# touches no network. In test/dev the config is validated lazily on first
# use, with explicit non-secret values (spec/support/storage_env.rb,
# infra/docker/.env.example).
Rails.application.config.after_initialize do
  Blobs::StorageProvider.config_from(ENV) if Rails.env.production?
end
