require 'rails_helper'
require 'rake'
require 'tempfile'

# Account deletion tombstones (Accounts::Tombstones): real deletions through
# Accounts::Delete, a simulated backup restore, and the runbook's rake tasks.
RSpec.describe Accounts::Tombstones do
  def make_user = User.create!(email: "tomb-#{SecureRandom.hex(4)}@example.test")

  it 'records hashed id + time (no PII) in the deletion transaction, kept after the user row is gone' do
    user = make_user
    Accounts::Delete.call(user: user)
    expect(User.exists?(user.id)).to be(false)

    tombstone = AccountTombstone.sole
    expect(tombstone.user_id_digest).to eq(Digest::SHA256.hexdigest("my-secrect/account-tombstone/v1:#{user.id}"))
    expect(tombstone.deleted_at).to be_within(5.seconds).of(Time.current)
    expect(tombstone.attributes.to_json).not_to include(user.email)
    expect(tombstone.attributes.to_json).not_to include(user.id)
  end

  it 'writes the out-of-database copy as a log line without PII' do
    io = StringIO.new
    capture = ActiveSupport::Logger.new(io)
    Rails.logger.broadcast_to(capture)
    user = make_user
    begin
      Accounts::Delete.call(user: user)
    ensure
      Rails.logger.stop_broadcasting_to(capture)
    end
    line = io.string.lines.find { |l| l.include?('[account_tombstone]') }
    expect(line).to include("user_id_digest=#{described_class.digest(user.id)}")
    expect(line).not_to include(user.email)
    expect(line).not_to include(user.id)
    expect(described_class.parse([line]).first['user_id_digest']).to eq(described_class.digest(user.id))
  end

  it 're-applies a deletion after a restore brings the account back (export -> restore -> import -> reapply)' do
    deleted = make_user
    survivor = make_user
    Accounts::Delete.call(user: deleted)
    exported = described_class.export

    # Restore of a backup taken before the deletion: the account row (and
    # its data) is back, and the restored database has no tombstone.
    AccountTombstone.delete_all
    restored = User.create!(id: deleted.id, email: deleted.email)
    restored.authenticators.create!(credential_id: SecureRandom.hex(8), public_key: 'cose')
    restored.vaults.create!

    expect(described_class.import!(exported)).to eq(1)
    expect(described_class.import!(exported)).to eq(0) # idempotent
    expect(described_class.reapply!).to eq(1)
    expect(User.exists?(deleted.id)).to be(false)
    expect(Vault.where(owner_id: deleted.id)).to be_empty
    expect(User.exists?(survivor.id)).to be(true)
    expect(AccountTombstone.count).to eq(1)
  end

  it 'refuses malformed tombstone input' do
    expect { described_class.parse(['not json']) }.to raise_error(ArgumentError)
    expect { described_class.import!([{ 'user_id_digest' => 'abc', 'deleted_at' => Time.current.iso8601 }]) }
      .to raise_error(ArgumentError)
  end

  it 'runs the runbook rake tasks end to end' do
    Rails.application.load_tasks if Rake::Task.tasks.none? { |t| t.name == 'accounts:tombstones:export' }
    user = make_user
    Accounts::Delete.call(user: user)
    exported = capture_stdout { Rake::Task['accounts:tombstones:export'].execute }
    AccountTombstone.delete_all
    User.create!(id: user.id, email: user.email)

    Tempfile.create(['tombstones', '.jsonl']) do |file|
      file.write(exported)
      file.flush
      import_out = capture_stdout { Rake::Task['accounts:tombstones:import'].execute(Rake::TaskArguments.new([:path], [file.path])) }
      expect(import_out).to include('imported 1 new tombstones (1 read)')
    end
    expect(capture_stdout { Rake::Task['accounts:tombstones:reapply'].execute }).to include('re-deleted 1 accounts')
    expect(User.exists?(user.id)).to be(false)
  end

  def capture_stdout
    original = $stdout
    $stdout = StringIO.new
    yield
    $stdout.string
  ensure
    $stdout = original
  end
end
