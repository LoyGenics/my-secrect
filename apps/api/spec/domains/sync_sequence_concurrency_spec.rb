require 'rails_helper'

# Real concurrency against real Postgres: several threads, each with its own
# connection, write to ONE vault at the same time. No stubs.
#
# Transactional fixtures are off: with them on, rspec-rails pins every thread
# to one shared connection inside one transaction and nothing is concurrent.
# Tables are truncated after each example.
RSpec.describe 'Sync sequence allocation under concurrency' do
  self.use_transactional_tests = false

  let!(:user) { create(:user) }
  let!(:device) { create(:device, user: user) }
  let!(:vault_id) { create(:vault, owner: user).id }

  after do
    conn = ActiveRecord::Base.connection
    conn.execute('TRUNCATE sync_events, item_versions, items, vaults, devices, audit_events, users RESTART IDENTITY CASCADE')
  end

  def bytes = Base64.strict_encode64(SecureRandom.random_bytes(48))

  def push(item_id:, base_revision:, operation: 'upsert')
    Sync::Push.call(
      vault: Vault.find(vault_id), item_id: item_id, base_revision: base_revision, operation: operation,
      encrypted_payload: operation == 'upsert' ? bytes : nil,
      encrypted_item_key: operation == 'upsert' ? bytes : nil,
      device: device
    )
  end

  # pg_stat_activity is snapshotted per transaction: clear it before each read.
  def blocked_backends
    conn = ActiveRecord::Base.connection
    conn.execute('SELECT pg_stat_clear_snapshot()')
    conn.select_value(<<~SQL).to_i
      SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    SQL
  end

  # Runs one writer per block, all at once, and returns each block's value
  # (or the exception it raised).
  #
  # To make the race deterministic without stubbing, the test's own
  # connection holds SHARE MODE on sync_events while the writers start:
  # reads (max(sequence)) proceed, every INSERT into sync_events waits. The
  # lock is released only once every writer is blocked on a lock — either on
  # that INSERT after reading max (a read-then-write race: they all read the
  # same max) or on the vault row lock (serialised: only one has read max) —
  # or has already finished (a push rejected before it writes).
  def race(writers)
    conn = ActiveRecord::Base.connection
    threads = []
    settled = 0
    conn.transaction do
      conn.execute('LOCK TABLE sync_events IN SHARE MODE')
      threads = writers.map do |writer|
        Thread.new do
          ActiveRecord::Base.connection_pool.with_connection do
            writer.call
          rescue StandardError => e
            e
          end
        end
      end
      deadline = Time.now + 15
      sleep 0.02 until (settled = blocked_backends + threads.count { |t| !t.alive? }) >= writers.size || Time.now > deadline
    end
    results = threads.map(&:value)
    expect(settled).to eq(writers.size)
    results
  end

  def sequences = SyncEvent.where(vault_id: vault_id).order(:sequence).pluck(:sequence)

  it 'gives simultaneous pushes for different items unique, gap-free sequences' do
    ids = Array.new(4) { SecureRandom.uuid }

    results = race(ids.map { |id| -> { push(item_id: id, base_revision: 0) } })

    expect(results).to all(be_a(Hash))
    expect(results.map { |r| r[:sequence] }).to match_array([1, 2, 3, 4])
    expect(sequences).to eq([1, 2, 3, 4])
    expect(SyncEvent.where(vault_id: vault_id).pluck(:item_id)).to match_array(ids)
  end

  # Sequence allocation must not depend on the caller: EncryptedRecords::Upsert
  # and ::Delete lock the vault themselves, so a direct caller that skips
  # Sync::Push cannot hand out the same sequence twice.
  it 'stays unique and gap-free when Upsert and Delete are called directly' do
    existing = SecureRandom.uuid
    push(item_id: existing, base_revision: 0)
    fresh = Array.new(3) { SecureRandom.uuid }
    upsert = lambda do |id|
      lambda do
        EncryptedRecords::Upsert.call(
          vault: Vault.find(vault_id), item_id: id, base_revision: 0,
          encrypted_payload: SecureRandom.random_bytes(48), encrypted_item_key: SecureRandom.random_bytes(48), device: device
        )
      end
    end
    delete = -> { EncryptedRecords::Delete.call(vault: Vault.find(vault_id), item_id: existing, base_revision: 1, device: device) }

    results = race(fresh.map { |id| upsert.call(id) } + [delete])

    expect(results).to all(be_a(Hash))
    expect(sequences).to eq([1, 2, 3, 4, 5])
    expect(SyncEvent.where(vault_id: vault_id, sequence: 2..5).pluck(:operation).tally).to eq('upsert' => 3, 'delete' => 1)
  end

  it 'releases the sequence of a push that fails, so the log stays gap-free' do
    taken = SecureRandom.uuid
    push(item_id: taken, base_revision: 0)
    ids = Array.new(3) { SecureRandom.uuid }

    # The stale write (base 0 on an item already at revision 1) is rejected
    # inside its transaction after the vault lock was taken.
    results = race(ids.map { |id| -> { push(item_id: id, base_revision: 0) } } + [-> { push(item_id: taken, base_revision: 0) }])

    expect(results.first(3)).to all(be_a(Hash))
    expect(results.last).to be_a(Sync::Push::RevisionConflict)
    expect(results.last.current_revision).to eq(1)
    expect(sequences).to eq([1, 2, 3, 4])
  end

  # Free-running (no held lock): writers push upserts, edits and deletes while
  # a reader pages with a cursor, exactly as a client does. Because sequence
  # N commits before N+1 is allocated, every page the reader sees continues
  # its cursor without a hole, and nothing is skipped or seen twice.
  it 'lets a cursor reader running alongside writers see every event exactly once, in order' do
    writers = Array.new(3) do
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          4.times do
            id = SecureRandom.uuid
            push(item_id: id, base_revision: 0)
            push(item_id: id, base_revision: 1)
            push(item_id: id, base_revision: 2, operation: 'delete')
          end
        end
      end
    end
    seen = []
    holes = []
    reader = Thread.new do
      ActiveRecord::Base.connection_pool.with_connection do
        cursor = 0
        loop do
          done = writers.none?(&:alive?)
          page = Sync::Pull.call(vault: Vault.find(vault_id), since: cursor)[:events].map { |e| e[:sequence] }
          holes << [cursor, page] unless page == ((cursor + 1)..(cursor + page.size)).to_a
          seen.concat(page)
          cursor = page.last if page.any?
          break if done && page.empty?
        end
      end
    end
    writers.each(&:join)
    reader.join

    expect(holes).to eq([])
    expect(seen).to eq((1..36).to_a)
    expect(sequences).to eq((1..36).to_a)
    upserts = SyncEvent.where(vault_id: vault_id, operation: 'upsert').pluck(:item_id, :revision)
    versions = ItemVersion.where(item_id: upserts.map(&:first)).pluck(:item_id, :revision)
    expect(versions).to match_array(upserts)
  end
end
