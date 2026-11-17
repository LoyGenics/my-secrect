require 'rails_helper'
require 'open3'
require 'securerandom'

# Mail delivery for sign-up codes (config/initializers/action_mailer.rb).
# The last examples boot the REAL app in RAILS_ENV=production in a child
# process: production must refuse to start without SMTP settings.
RSpec.describe 'Sign-up mail delivery configuration' do
  let(:smtp_env) do
    { 'SMTP_ADDRESS' => 'smtp.example.test', 'SMTP_PORT' => '587', 'SMTP_USERNAME' => 'mailer',
      'SMTP_PASSWORD' => SecureRandom.hex(8), 'MAIL_FROM' => 'my-secrect <no-reply@example.test>' }
  end

  it 'fails closed in production when any SMTP variable is missing or blank' do
    AuthMailDelivery::REQUIRED_SMTP_ENV.each do |key|
      expect { AuthMailDelivery.settings(rails_env: 'production', env: smtp_env.except(key)) }
        .to raise_error(AuthMailDelivery::ConfigurationError, /#{key}/)
      expect { AuthMailDelivery.settings(rails_env: 'production', env: smtp_env.merge(key => ' ')) }
        .to raise_error(AuthMailDelivery::ConfigurationError, /#{key}/)
    end
  end

  it 'uses SMTP with mandatory STARTTLS and peer verification in production, never :file' do
    settings = AuthMailDelivery.settings(rails_env: 'production', env: smtp_env.merge('MAIL_FILE_DIR' => '/tmp/x'))
    expect(settings[:delivery_method]).to eq(:smtp)
    expect(settings[:from]).to eq('my-secrect <no-reply@example.test>')
    expect(settings[:smtp_settings]).to include(address: 'smtp.example.test', port: 587, enable_starttls: :always,
                                                tls: false, openssl_verify_mode: 'peer')
    implicit = AuthMailDelivery.settings(rails_env: 'production', env: smtp_env.merge('SMTP_TLS_MODE' => 'tls'))
    expect(implicit[:smtp_settings]).to include(tls: true, enable_starttls: false)
  end

  it 'uses :test in test, :file only with MAIL_FILE_DIR (e2e), and :file into tmp/mails in development' do
    expect(AuthMailDelivery.settings(rails_env: 'test', env: {})[:delivery_method]).to eq(:test)
    e2e = AuthMailDelivery.settings(rails_env: 'test', env: { 'MAIL_FILE_DIR' => '/tmp/e2e-mail' })
    expect(e2e).to include(delivery_method: :file, file_settings: { location: '/tmp/e2e-mail' })
    dev = AuthMailDelivery.settings(rails_env: 'development', env: {})
    expect(dev[:delivery_method]).to eq(:file)
    expect(dev[:file_settings][:location]).to end_with('tmp/mails')
  end

  it 'disables the Action Mailer logger (message bodies carry the code)' do
    expect(ActionMailer::Base.logger).to be_nil
  end

  describe 'booting RAILS_ENV=production' do
    def boot_production(extra_env)
      env = { 'RAILS_ENV' => 'production', 'SECRET_KEY_BASE' => SecureRandom.hex(64),
              'REDIS_URL' => 'redis://127.0.0.1:6379/15', 'MAIL_FILE_DIR' => nil }
      AuthMailDelivery::REQUIRED_SMTP_ENV.each { |key| env[key] = nil }
      Open3.capture2e(env.merge(extra_env), 'bundle', 'exec', 'ruby', '-e',
                      'require "./config/environment"; puts "BOOTED"', chdir: Rails.root.to_s)
    end

    it 'refuses to start without SMTP settings' do
      output, status = boot_production({})
      expect(status).not_to be_success
      expect(output).to include('production requires SMTP for sign-up verification codes')
      expect(output).not_to include('BOOTED')
    end

    it 'starts with SMTP settings' do
      output, status = boot_production(smtp_env)
      expect(output).to include('BOOTED')
      expect(status).to be_success
    end
  end
end
