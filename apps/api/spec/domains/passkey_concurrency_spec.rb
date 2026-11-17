require 'rails_helper'
require 'webauthn/fake_client'

# Real concurrency: threads, real Postgres connections, real WebAuthn
# verification (FakeClient assertions) — no stubs. Transactional fixtures
# are disabled so each thread's connection sees committed rows; tables are
# truncated after each example.
RSpec.describe 'Passkey verify concurrency' do
  # Must be off, or rspec-rails pins every thread to one shared connection
  # inside one transaction and nothing is actually concurrent.
  self.use_transactional_tests = false

  let(:origin) { 'http://localhost:3000' }
  let(:email) { 'passkey-race@example.test' }
  let(:client) { WebAuthn::FakeClient.new(origin) }

  after do
    conn = ActiveRecord::Base.connection
    tables = %w[device_challenges sessions devices authenticators passkey_challenges email_verifications audit_events users]
             .select { |t| conn.table_exists?(t) }
    conn.execute("TRUNCATE #{tables.map { |t| conn.quote_table_name(t) }.join(', ')} RESTART IDENTITY CASCADE")
  end

  def register!
    options = Authentication::Passkeys.registration_options(email: email, registration_ticket: registration_ticket_for(email))
    credential = client.create(challenge: options[:creation_options][:challenge] || options['creation_options']['challenge'], user_verified: true)
    Authentication::Passkeys.verify(email: email, credential: credential, kind: 'registration')
  end

  def assertion(sign_count: nil)
    options = Authentication::Passkeys.authentication_options(email: email)
    challenge = (options[:request_options] || options['request_options'])
    challenge = challenge[:challenge] || challenge['challenge']
    allow = User.find_by(email: email).authenticators.active.pluck(:credential_id)
    client.get(challenge: challenge, sign_count: sign_count, user_verified: true, allow_credentials: allow)
  end

  # Fire all verifications at once and return per-thread :ok / error message.
  #
  # To make the race window deterministic (no stubbing), the test holds a
  # row lock on `locked_scope` from its own connection while the threads
  # run. Plain reads are not blocked, so every thread passes its read
  # checks; every WRITE to the locked rows then queues behind the lock and
  # is released together. Code with a read-then-write flaw lets several
  # threads win; atomic code lets exactly one.
  def race(credentials, locked_scope:)
    started = Queue.new
    barrier = Queue.new
    threads = credentials.map do |cred|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          started << true
          barrier.pop
          begin
            Authentication::Passkeys.verify(email: email, credential: cred, kind: 'authentication')
            :ok
          rescue Authentication::Passkeys::VerificationError => e
            e.message
          end
        end
      end
    end
    credentials.size.times { started.pop }
    locked_scope.transaction do
      locked_scope.lock.to_a
      credentials.size.times { barrier << true }
      sleep 1.0 # let every thread reach (and block on) its write
    end
    threads.map(&:value)
  end

  it 'lets exactly one of several simultaneous identical assertions succeed' do
    register!
    cred = assertion
    sessions_before = Session.count

    results = race([cred] * 4, locked_scope: PasskeyChallenge)

    expect(results.count(:ok)).to eq(1)
    expect(results - [:ok]).to all(eq('challenge expired or already used'))
    expect(Session.count - sessions_before).to eq(1)
    expect(Authenticator.last.sign_count).to eq(1)
  end

  it 'accepts only one of several simultaneous assertions carrying the same counter' do
    register!
    creds = Array.new(4) { assertion(sign_count: 5) }
    sessions_before = Session.count

    results = race(creds, locked_scope: Authenticator)

    expect(results.count(:ok)).to eq(1)
    expect(results - [:ok]).to all(eq('verification failed'))
    expect(Session.count - sessions_before).to eq(1)
    expect(Authenticator.last.sign_count).to eq(5)
  end
end
