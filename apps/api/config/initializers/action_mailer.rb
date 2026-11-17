# Mail delivery for the sign-up verification code (AuthMailer). The code
# is the proof of email ownership, so:
#
#   * production — SMTP only, configured from env. Booting production
#     without every REQUIRED_SMTP_ENV variable RAISES here (fail closed):
#     a deployment that cannot send codes must not start and silently
#     accept sign-ups it cannot verify. STARTTLS is required (or implicit
#     TLS with SMTP_TLS_MODE=tls); certificates are verified.
#   * development — :file delivery into tmp/mails (one file per
#     recipient address), unless MAIL_FILE_DIR points elsewhere.
#   * test — :test delivery (ActionMailer::Base.deliveries) for RSpec,
#     unless MAIL_FILE_DIR is set: the browser e2e harness
#     (tests/e2e-web/stack.ts) sets it so Playwright reads the code from
#     the delivered file, exactly as a user reads their inbox. There is no
#     server-side bypass: the API never returns the code, and :file is
#     refused in production.
#
# Logging: Action Mailer logs the whole message (including the code) at
# debug level. Its logger is removed below in EVERY environment so the
# code can never reach a log file (spec/requests/api/v1/log_redaction_spec.rb
# greps the log output to prove it).
module AuthMailDelivery
  REQUIRED_SMTP_ENV = %w[SMTP_ADDRESS SMTP_PORT SMTP_USERNAME SMTP_PASSWORD MAIL_FROM].freeze
  DEV_FROM = 'my-secrect <no-reply@localhost>'

  class ConfigurationError < StandardError; end

  module_function

  # Pure function of (Rails env, ENV hash) so the fail-closed rule is
  # unit-testable without booting production.
  def settings(rails_env:, env:)
    return smtp_settings(env) if rails_env.to_s == 'production'

    from = env['MAIL_FROM'].presence || DEV_FROM
    if env['MAIL_FILE_DIR'].present?
      { delivery_method: :file, file_settings: { location: env['MAIL_FILE_DIR'] }, from: from }
    elsif rails_env.to_s == 'test'
      { delivery_method: :test, from: from }
    else
      { delivery_method: :file, file_settings: { location: Rails.root.join('tmp/mails').to_s }, from: from }
    end
  end

  def smtp_settings(env)
    missing = REQUIRED_SMTP_ENV.select { |key| env[key].blank? }
    if missing.any?
      raise ConfigurationError,
            "production requires SMTP for sign-up verification codes; missing: #{missing.join(', ')}"
    end

    implicit_tls = env['SMTP_TLS_MODE'].to_s == 'tls'
    {
      delivery_method: :smtp,
      from: env['MAIL_FROM'],
      smtp_settings: {
        address: env['SMTP_ADDRESS'],
        port: Integer(env['SMTP_PORT']),
        user_name: env['SMTP_USERNAME'],
        password: env['SMTP_PASSWORD'],
        authentication: env['SMTP_AUTHENTICATION'].presence || 'plain',
        tls: implicit_tls,
        # Without implicit TLS, STARTTLS is mandatory (:always), never
        # opportunistic: the code must not cross the network in clear.
        enable_starttls: implicit_tls ? false : :always,
        openssl_verify_mode: 'peer',
        open_timeout: 5,
        read_timeout: 10
      }
    }
  end
end

# Evaluated at boot, so production raises here (fail closed) instead of
# at the first sign-up.
auth_mail_settings = AuthMailDelivery.settings(rails_env: Rails.env, env: ENV)

ActiveSupport.on_load(:action_mailer) do
  self.delivery_method = auth_mail_settings[:delivery_method]
  self.smtp_settings = auth_mail_settings[:smtp_settings] if auth_mail_settings[:smtp_settings]
  self.file_settings = auth_mail_settings[:file_settings] if auth_mail_settings[:file_settings]
  self.default_options = { from: auth_mail_settings[:from] }
  self.raise_delivery_errors = true
  self.perform_deliveries = true
  # Never log message bodies (they contain the verification code).
  self.logger = nil
end
