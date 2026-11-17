require 'rails_helper'

# A push that fails part-way leaves no partial state: never an event without
# its version, a version without its event, or a bumped item revision without
# both. The failure is real — a Postgres trigger raises inside the INSERT,
# after the earlier writes of the same push succeeded — not a stub.
#
# Transactional fixtures are off so each push runs in its own real
# transaction (not a savepoint inside the test's), as in production.
RSpec.describe 'Sync push atomicity' do
  self.use_transactional_tests = false

  let!(:user) { create(:user) }
  let!(:device) { create(:device, user: user) }
  let!(:vault) { create(:vault, owner: user) }
  let(:item_id) { SecureRandom.uuid }

  after do
    conn = ActiveRecord::Base.connection
    conn.execute('DROP FUNCTION IF EXISTS sync_spec_injected_fault() CASCADE')
    conn.execute('TRUNCATE sync_events, item_versions, items, vaults, devices, audit_events, users RESTART IDENTITY CASCADE')
  end

  def push(base:, operation: 'upsert', payload: SecureRandom.random_bytes(48))
    Sync::Push.call(
      vault: Vault.find(vault.id), item_id: item_id, base_revision: base, operation: operation,
      encrypted_payload: operation == 'upsert' ? Base64.strict_encode64(payload) : nil,
      encrypted_item_key: operation == 'upsert' ? Base64.strict_encode64(SecureRandom.random_bytes(40)) : nil,
      device: device
    )
  end

  # Every INSERT into `table` raises while the block runs.
  def failing_inserts_into(table)
    conn = ActiveRecord::Base.connection
    conn.execute(<<~SQL)
      CREATE FUNCTION sync_spec_injected_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected fault on %', TG_TABLE_NAME; END $$
    SQL
    conn.execute("CREATE TRIGGER sync_spec_injected_fault BEFORE INSERT ON #{conn.quote_table_name(table)} FOR EACH ROW EXECUTE FUNCTION sync_spec_injected_fault()")
    yield
  ensure
    conn.execute('DROP FUNCTION IF EXISTS sync_spec_injected_fault() CASCADE')
  end

  def state
    {
      item: Item.where(id: item_id).pick(:current_revision, :deleted_at),
      versions: ItemVersion.where(item_id: item_id).order(:revision).pluck(:revision),
      events: SyncEvent.where(vault_id: vault.id).order(:sequence).pluck(:sequence, :revision, :operation)
    }
  end

  it 'creates nothing when the event insert of a first push fails, and the retry takes sequence 1' do
    failing_inserts_into('sync_events') do
      expect { push(base: 0) }.to raise_error(ActiveRecord::StatementInvalid, /injected fault on sync_events/)
    end
    expect(state).to eq(item: nil, versions: [], events: [])

    expect(push(base: 0)).to eq(item_id: item_id, revision: 1, sequence: 1)
  end

  it 'leaves the item at its revision when the event insert of an edit fails' do
    push(base: 0)
    before = state
    failing_inserts_into('sync_events') do
      expect { push(base: 1) }.to raise_error(ActiveRecord::StatementInvalid, /injected fault/)
    end
    expect(state).to eq(before)
    expect(before[:versions]).to eq([1])

    expect(push(base: 1)).to eq(item_id: item_id, revision: 2, sequence: 2)
  end

  it 'leaves no event and no revision bump when the version insert fails' do
    push(base: 0)
    before = state
    failing_inserts_into('item_versions') do
      expect { push(base: 1) }.to raise_error(ActiveRecord::StatementInvalid, /injected fault on item_versions/)
    end
    expect(state).to eq(before)
  end

  it 'does not tombstone the item when the event insert of a delete fails' do
    push(base: 0)
    before = state
    failing_inserts_into('sync_events') do
      expect { push(base: 1, operation: 'delete') }.to raise_error(ActiveRecord::StatementInvalid, /injected fault/)
    end
    expect(state).to eq(before)
    expect(before[:item]).to eq([1, nil])

    result = push(base: 1, operation: 'delete')
    expect(result.slice(:revision, :sequence)).to eq(revision: 2, sequence: 2)
    expect(state[:events]).to eq([[1, 1, 'upsert'], [2, 2, 'delete']])
  end
end
