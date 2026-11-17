require 'rails_helper'

# Rack::Attack throttles (config/initializers/rack_attack.rb) through the
# real middleware stack. Throttling is off by default in the test env
# (other request specs drive many auth calls from one IP); this file turns
# it on, starts every example with empty counters, and proves each limit
# fires — and that a throttled request never reaches the application.
RSpec.describe 'Rate limiting', type: :request do
  around do |example|
    previous = Rack::Attack.enabled
    Rack::Attack.enabled = true
    Rack::Attack.reset!
    example.run
  ensure
    Rack::Attack.reset!
    Rack::Attack.enabled = previous
  end

  def json_body = JSON.parse(response.body)

  def hit(path, ip: '203.0.113.10', params: {}, headers: {})
    post path, params: params, headers: headers, env: { 'REMOTE_ADDR' => ip }, as: :json
    response.status
  end

  def expect_throttled
    expect(response).to have_http_status(:too_many_requests)
    expect(json_body).to eq('error' => 'rate_limited')
  end

  def email = "rl-#{SecureRandom.hex(4)}@example.test"

  it 'uses an in-process MemoryStore outside production' do
    expect(Rack::Attack.cache.store).to be_a(ActiveSupport::Cache::MemoryStore)
  end

  describe 'store configuration' do
    it 'refuses production without REDIS_URL and uses Redis with it' do
      expect { RackAttackStore.build(rails_env: 'production', env: {}) }
        .to raise_error(RackAttackStore::ConfigurationError, /REDIS_URL/)
      store = RackAttackStore.build(rails_env: 'production', env: { 'REDIS_URL' => 'redis://127.0.0.1:6379/15' })
      expect(store).to be_a(ActiveSupport::Cache::RedisCacheStore)
    end
  end

  describe 'sign-up email codes' do
    it 'limits code requests per IP (5/min) and the 6th sends no mail' do
      5.times { expect(hit('/api/v1/auth/email/request', params: { email: email })).to eq(202) }
      hit('/api/v1/auth/email/request', params: { email: email })
      expect_throttled
      expect(ActionMailer::Base.deliveries.size).to eq(5)
    end

    it 'limits code requests per address (3/10 min) even from different IPs' do
      address = email
      3.times { |i| expect(hit('/api/v1/auth/email/request', ip: "198.51.100.#{i}", params: { email: address })).to eq(202) }
      hit('/api/v1/auth/email/request', ip: '198.51.100.99', params: { email: address.upcase })
      expect_throttled
      expect(delivered_mails_to(address).size).to eq(3)
    end

    it 'limits code verification per IP (10/min) and per address across IPs (10/10 min)' do
      10.times { expect(hit('/api/v1/auth/email/verify', params: { email: email, code: '000000' })).to eq(401) }
      hit('/api/v1/auth/email/verify', params: { email: email, code: '000000' })
      expect_throttled

      Rack::Attack.reset!
      address = email
      10.times { |i| expect(hit('/api/v1/auth/email/verify', ip: "198.51.100.#{i}", params: { email: address, code: '000000' })).to eq(401) }
      hit('/api/v1/auth/email/verify', ip: '198.51.100.200', params: { email: address, code: '000000' })
      expect_throttled
    end
  end

  describe 'passkeys' do
    it 'limits passkey options per IP (10/min)' do
      10.times { expect(hit('/api/v1/auth/passkeys/authenticate', params: { email: email })).to eq(200) }
      hit('/api/v1/auth/passkeys/authenticate', params: { email: email })
      expect_throttled
    end

    it 'limits passkey verify per account email across IPs (10/min)' do
      address = email
      10.times do |i|
        expect(hit('/api/v1/auth/passkeys/verify', ip: "198.51.100.#{i}",
                                                   params: { email: address, kind: 'authentication', credential: { id: 'x' } })).to eq(401)
      end
      hit('/api/v1/auth/passkeys/verify', ip: '198.51.100.50', params: { email: address, kind: 'authentication', credential: { id: 'x' } })
      expect_throttled
    end
  end

  describe 'second factors and recovery' do
    it 'limits MFA verify per IP (5/min)' do
      5.times { expect(hit('/api/v1/auth/mfa/verify', params: { mfa_token: 'mfa_x', code: '123456' })).to eq(401) }
      hit('/api/v1/auth/mfa/verify', params: { mfa_token: 'mfa_x', code: '123456' })
      expect_throttled
    end

    it 'limits step-up per IP (10/min), before authentication is even checked' do
      10.times { expect(hit('/api/v1/auth/step-up/totp', params: { code: '123456' })).to eq(401) }
      hit('/api/v1/auth/step-up/totp', params: { code: '123456' })
      expect_throttled
    end

    it 'limits recovery verify per IP (5/min) and per address across IPs (5/5 min)' do
      params = { email: email, challenge_id: SecureRandom.uuid, signature: 'AAAA' }
      5.times { expect(hit('/api/v1/recovery/verify', params: params)).to eq(401) }
      hit('/api/v1/recovery/verify', params: params)
      expect_throttled

      Rack::Attack.reset!
      address = email
      5.times { |i| expect(hit('/api/v1/recovery/verify', ip: "198.51.100.#{i}", params: params.merge(email: address))).to eq(401) }
      hit('/api/v1/recovery/verify', ip: '198.51.100.77', params: params.merge(email: address))
      expect_throttled
    end
  end

  it 'limits device proof endpoints per IP (10/min)' do
    user = User.create!(email: email)
    headers = auth_headers_for(user)
    10.times { expect(hit('/api/v1/devices/challenges', params: { purpose: 'session-bind' }, headers: headers)).to eq(201) }
    hit('/api/v1/devices/challenges', params: { purpose: 'session-bind' }, headers: headers)
    expect_throttled
    expect(DeviceChallenge.count).to eq(10)
  end

  it 'counts per IP: another client is not affected' do
    10.times { hit('/api/v1/auth/passkeys/authenticate', params: { email: email }) }
    hit('/api/v1/auth/passkeys/authenticate', params: { email: email })
    expect_throttled
    expect(hit('/api/v1/auth/passkeys/authenticate', ip: '192.0.2.44', params: { email: email })).to eq(200)
  end
end
