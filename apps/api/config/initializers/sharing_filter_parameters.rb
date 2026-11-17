# Sharing ciphertext (specs/sharing-protocol.md) is never written to request
# logs, same rule as vault ciphertext. encrypted_payload and
# encrypted_item_key are already filtered in config/application.rb.
Rails.application.config.filter_parameters += %i[encrypted_secret_key encrypted_owner_metadata]
