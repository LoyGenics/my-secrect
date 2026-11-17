require 'active_support/core_ext/integer/time'
Rails.application.configure do
  config.cache_classes = true
  config.eager_load = true
  config.consider_all_requests_local = false
  config.public_file_server.enabled = false
  config.log_level = :info
  config.log_tags = [:request_id]
  config.active_record.dump_schema_after_migration = false
  config.force_ssl = true
  # Never log ciphertext or key material, even at debug level.
  config.filter_parameters += %i[encrypted_payload encrypted_item_key encrypted_key signature]
end
