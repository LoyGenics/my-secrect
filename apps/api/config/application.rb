require_relative 'boot'
# Explicit frameworks instead of rails/all: this API has no Active Storage
# (object storage goes through Blobs::StorageProvider), cable, text or
# mailbox. rails/all made production eager-load fail on the missing
# config/storage.yml. Action Mailer is loaded for ONE purpose: emailing
# the sign-up verification code (AuthMailer; delivery configured, and
# required in production, by config/initializers/action_mailer.rb).
require 'rails'
require 'active_model/railtie'
require 'active_job/railtie'
require 'active_record/railtie'
require 'action_controller/railtie'
require 'action_mailer/railtie'
Bundler.require(*Rails.groups)

module MySecrectApi
  class Application < Rails::Application
    config.load_defaults 7.1
    config.api_only = true
    # Domain files are app/domains/<context>/*.rb and must load as <Context>::*.
    # app/domains is already an autoload root because it sits under app/.
    # Do not add each child directory as its own root: Zeitwerk would expect
    # top-level constants (UploadSession) and Blobs:: / Authentication:: would
    # never be defined.
    config.active_record.schema_format = :ruby
    # The API never serves HTML. All responses are JSON, all payloads are
    # ciphertext + opaque ids. No plaintext vault content is ever logged.
    config.filter_parameters += %i[password encrypted_payload encrypted_item_key encrypted_key totp_secret code recovery_code signature mfa_token challenge ticket]
    # Mount Rack::Attack so the throttles in config/initializers/rack_attack.rb
    # actually run (they were defined but never mounted before).
    config.middleware.use Rack::Attack
    config.generators do |g|
      g.test_framework :rspec, request_specs: true
      g.fixture_replacement :factory_bot, dir: 'spec/factories'
    end
  end
end
