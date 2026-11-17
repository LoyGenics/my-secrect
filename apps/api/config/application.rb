require_relative 'boot'
require 'rails/all'
Bundler.require(*Rails.groups)

module MySecrectApi
  class Application < Rails::Application
    config.load_defaults 7.1
    config.api_only = true
    # Domain files live in app/domains/<name>/*.rb and define <Name>::*.
    # Rails already autoloads app/domains. Adding each child directory as
    # its own root collapses those namespaces onto Object, so Sync::Push
    # and Authentication::SessionTokens never resolve.
    config.active_record.schema_format = :ruby
    # The API never serves HTML. All responses are JSON, all payloads are
    # ciphertext + opaque ids. No plaintext vault content is ever logged.
    config.filter_parameters += %i[password encrypted_payload encrypted_item_key encrypted_key totp_secret code recovery_code signature mfa_token challenge]
    # Mount Rack::Attack so the throttles in config/initializers/rack_attack.rb
    # actually run (they were defined but never mounted before).
    config.middleware.use Rack::Attack
    config.generators do |g|
      g.test_framework :rspec, request_specs: true
      g.fixture_replacement :factory_bot, dir: 'spec/factories'
    end
  end
end
