require_relative 'boot'
require 'rails/all'
Bundler.require(*Rails.groups)

module MySecrectApi
  class Application < Rails::Application
    config.load_defaults 7.1
    config.api_only = true
    # Modular monolith: domain logic lives in app/domains/*, autoloaded.
    config.autoload_paths += Dir[Rails.root.join('app/domains/*/')]
    config.eager_load_paths += Dir[Rails.root.join('app/domains/*/')]
    config.active_record.schema_format = :ruby
    # The API never serves HTML. All responses are JSON, all payloads are
    # ciphertext + opaque ids. No plaintext vault content is ever logged.
    config.filter_parameters += %i[password encrypted_payload encrypted_item_key encrypted_key]
    config.generators do |g|
      g.test_framework :rspec, request_specs: true
      g.fixture_replacement :factory_bot, dir: 'spec/factories'
    end
  end
end
