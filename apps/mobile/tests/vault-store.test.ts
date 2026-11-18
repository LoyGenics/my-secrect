/**
 * Real-module tests: src/storage/{sql,vaultStore,migration,autofillIndex}.ts
 * on a real SQLite (sql.js). Run:
 *   npx tsx --test apps/mobile/tests/vault-store.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autofillEntryFor, autofillIndexFor, hostForIndex } from '../src/storage/autofillIndex';
import { LEGACY_KEYS_KEY, LEGACY_ROWS_KEY, migrateFromAsyncStorage } from '../src/storage/migration';
import type { StoredRow } from '../src/storage/vaultStore';
import type { VaultItem } from '../../../packages/core/src/types';
import { MemoryKeyValue, openTestDb, openTestStore } from './support/sqljs';

const KEYS = JSON.stringify({
  salt: 's', wrapped_master: 'm', wrapped_master_nonce: 'mn', wrapped_vault: 'v', wrapped_vault_nonce: 'vn',
  wrapped_recovery: 'r', wrapped_recovery_nonce: 'rn',
});
const row = (id: string, extra: Partial<StoredRow> = {}): StoredRow => ({
  id, revision: 1, nonce: `n-${id}`, ciphertext: `c-${id}`, wrapped_item_key: `w-${id}`, wrapped_nonce: `wn-${id}`, deleted_at: null, ...extra,
});
function legacyWith(rows: unknown, keys: string | null = KEYS): MemoryKeyValue {
  const kv = new MemoryKeyValue();
  if (keys !== null) kv.map.set(LEGACY_KEYS_KEY, keys);
  if (rows !== undefined) kv.map.set(LEGACY_ROWS_KEY, typeof rows === 'string' ? rows : JSON.stringify(rows));
  kv.map.set('my-secrect.api-base-url', 'https://example.test'); // unrelated key: must survive
  return kv;
}

test('schema: provider contract and device-local card code table, schema_version 1', async () => {
  const { raw } = await openTestStore();
  const tables = (await raw.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((t) => t.name);
  assert.deepEqual(tables, ['autofill_index', 'device_unlock', 'local_card_codes', 'meta', 'rows', 'vault_keys']);
  const cols = async (t: string) => (await raw.all<{ name: string; notnull: number; pk: number }>(`PRAGMA table_info(${t})`)).map((c) => `${c.name}:${c.notnull}:${c.pk}`);
  assert.deepEqual(await cols('rows'), ['id:0:1', 'revision:1:0', 'nonce:1:0', 'ciphertext:1:0', 'wrapped_item_key:1:0', 'wrapped_nonce:1:0', 'deleted_at:0:0']);
  assert.deepEqual(await cols('device_unlock'), ['id:0:1', 'scheme:1:0', 'wrapped_amk:1:0', 'created_at:1:0']);
  assert.deepEqual(await cols('local_card_codes'), ['id:0:1', 'ciphertext:1:0']);
  assert.deepEqual(await cols('autofill_index'), ['id:0:1', 'title:1:0', 'username:1:0', 'host:1:0', 'type:1:0']);
  assert.deepEqual(await cols('vault_keys'), ['id:0:1', 'json:1:0']);
  assert.deepEqual(await raw.all('SELECT key, value FROM meta'), [{ key: 'schema_version', value: '1' }]);
  await assert.rejects(() => raw.run("INSERT INTO vault_keys (id, json) VALUES (2, '{}')"), /CHECK constraint/);
});

test('schema: an unknown schema_version is refused, not overwritten', async () => {
  const t = await openTestDb();
  const { VaultStore } = await import('../src/storage/vaultStore');
  await VaultStore.open(t.sql);
  await t.raw.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  await assert.rejects(() => VaultStore.open(t.sql), /schema_version 2 is not supported/);
});

test('transaction: a throw rolls back every statement in it', async () => {
  const { store, raw } = await openTestStore();
  // keys + first row are written, then the second insert hits the primary key.
  await assert.rejects(() => store.importLegacy(KEYS, [row('x'), row('x')]), /UNIQUE/);
  assert.equal((await raw.first<{ n: number }>('SELECT count(*) AS n FROM rows'))?.n, 0);
  assert.equal(await store.getKeysJson(), null);
  await store.createVault(KEYS);
  await assert.rejects(() => store.restoreVault(KEYS, [row('a')], []), /not empty/);
  assert.equal(await store.countRows(), 0);
});

test('migration: copies keys verbatim + every row, then deletes only the two legacy keys', async () => {
  const { store } = await openTestStore();
  const rows = [row('a'), row('b', { revision: 7, deleted_at: '2026-11-17T00:00:00.000Z' }), row('c')];
  delete (rows[0] as Partial<StoredRow>).deleted_at; // the old build left it undefined
  const kv = legacyWith(rows);
  assert.deepEqual(await migrateFromAsyncStorage(store, kv), { migrated: true, rows: 3 });
  assert.equal(await store.getKeysJson(), KEYS);
  assert.deepEqual(await store.listRows(), [row('a'), rows[1], row('c')]);
  assert.deepEqual([...kv.map.keys()], ['my-secrect.api-base-url']);
  assert.deepEqual(await migrateFromAsyncStorage(store, kv), { migrated: false });
});

test('migration: unreadable data copies nothing and leaves AsyncStorage untouched', async () => {
  const cases: Array<[string, MemoryKeyValue, RegExp]> = [
    ['rows not JSON', legacyWith('[{"id":'), /not valid JSON/],
    ['rows not a list', legacyWith({ a: 1 }), /not a list/],
    ['row missing ciphertext', legacyWith([row('a'), { ...row('b'), ciphertext: undefined }]), /row 1 has no ciphertext/],
    ['row revision not an integer', legacyWith([{ ...row('a'), revision: '1' }]), /integer revision/],
    ['duplicate row id', legacyWith([row('a'), row('a')]), /appears twice/],
    ['keys not JSON', legacyWith([row('a')], '{nope'), /not valid JSON/],
    ['keys missing a field', legacyWith([row('a')], JSON.stringify({ salt: 's' })), /missing fields/],
  ];
  for (const [label, kv, err] of cases) {
    const { store } = await openTestStore();
    const before = JSON.stringify([...kv.map]);
    await assert.rejects(() => migrateFromAsyncStorage(store, kv), err, label);
    assert.equal(JSON.stringify([...kv.map]), before, label);
    assert.equal(await store.countRows(), 0, label);
    assert.equal(await store.getKeysJson(), null, label);
  }
});

test('migration: a different vault already in vault.db is a conflict; neither side changes', async () => {
  const { store } = await openTestStore();
  await store.importLegacy(KEYS, [row('a')]);
  const kv = legacyWith([row('a', { ciphertext: 'changed' })]);
  const before = JSON.stringify([...kv.map]);
  await assert.rejects(() => migrateFromAsyncStorage(store, kv), /already holds a different vault/);
  assert.equal(JSON.stringify([...kv.map]), before);
  assert.deepEqual(await store.listRows(), [row('a')]);
});

test('migration: copy committed but cleanup failed -> the next launch finishes the cleanup', async () => {
  const { store } = await openTestStore();
  const kv = legacyWith([row('a'), row('b')]);
  kv.failRemove = true;
  await assert.rejects(() => migrateFromAsyncStorage(store, kv), /removeItem failed/);
  assert.equal(kv.map.size, 3);
  assert.equal(await store.countRows(), 2);
  kv.failRemove = false;
  assert.deepEqual(await migrateFromAsyncStorage(store, kv), { migrated: true, rows: 2 });
  assert.equal(await store.countRows(), 2);
  assert.deepEqual([...kv.map.keys()], ['my-secrect.api-base-url']);
});

test('migration: keys with no rows key (vault created, no item yet) migrate as an empty vault', async () => {
  const { store } = await openTestStore();
  const kv = legacyWith(undefined);
  assert.deepEqual(await migrateFromAsyncStorage(store, kv), { migrated: true, rows: 0 });
  assert.equal(await store.getKeysJson(), KEYS);
});

test('upsert: revision bumps and the index entry is written in the same transaction', async () => {
  const { store } = await openTestStore();
  await store.createVault(KEYS);
  const { revision: _r, ...base } = row('a');
  assert.equal(await store.upsertItemRow(base, { id: 'a', title: 'A', username: 'u', host: 'a.test', type: 'login' }), 1);
  assert.equal(await store.upsertItemRow(base, null), 2);
  assert.deepEqual(await store.listAutofillIndex(), []);
  await store.setDeletedAt('a', 'now', null);
  assert.equal((await store.listRows())[0].deleted_at, 'now');
  await store.deleteRow('a');
  assert.equal(await store.countRows(), 0);
});

test('wipe: keys, rows, device unlock, index and local card codes gone; schema_version kept', async () => {
  const { store, raw } = await openTestStore();
  await store.importLegacy(KEYS, [row('a')]);
  await store.upsertItemRow(row('a'), null, 'encrypted-code');
  await store.putDeviceUnlock({ scheme: 'ios-kc-aesgcm-v1', wrapped_amk: 'blob', created_at: 'now' });
  await store.replaceAutofillIndex([{ id: 'a', title: 'A', username: 'u', host: 'h', type: 'login' }]);
  await store.wipe();
  for (const t of ['vault_keys', 'rows', 'device_unlock', 'autofill_index', 'local_card_codes']) {
    assert.equal((await raw.first<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))?.n, 0, t);
  }
  assert.equal(await store.isOccupied(), false);
  assert.equal((await raw.first<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))?.value, '1');
});

const item = (over: Partial<VaultItem>): VaultItem => ({
  id: 'i', type: 'login', schema_version: 1, title: 'T', fields: {}, tags: [], relations: [], attachments: [],
  created_at: 'x', updated_at: 'x', ...over,
});

test('autofill index: login + passkey only, title/username/host only, never secrets', () => {
  const login = item({ id: 'l', title: 'Mail', fields: { username: 'ada', password: 'pw-SECRET', totp_secret: 'JBSWY3DP', notes: 'n', url: 'HTTPS://user:pw@WWW.Mail.Example.com:8443/login?x=1' } });
  const passkey = item({ id: 'p', type: 'passkey', title: 'PK', fields: { credential_id: 'cid', rp_id: 'Example.org', public_key: 'pk' } });
  const card = item({ id: 'c', type: 'card', fields: { cardholder: 'A' } });
  const trashed = item({ id: 't', deleted_at: '2026-01-01', fields: { url: 'https://t.test' } });
  const index = autofillIndexFor([login, passkey, card, trashed]);
  assert.deepEqual(index, [
    { id: 'l', title: 'Mail', username: 'ada', host: 'mail.example.com', type: 'login' },
    { id: 'p', title: 'PK', username: '', host: 'example.org', type: 'passkey' },
  ]);
  assert.doesNotMatch(JSON.stringify(index), /SECRET|JBSWY3DP|cid|pk"/);
  assert.equal(autofillEntryFor(item({ fields: { username: 'x' } }))?.host, '');
  assert.equal(hostForIndex('example.com/path'), 'example.com');
  assert.equal(hostForIndex('https://[::1]:443/'), '[::1]');
  assert.equal(hostForIndex(42), '');
});
