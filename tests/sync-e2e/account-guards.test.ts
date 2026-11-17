/**
 * Real clients (desktop vault + SyncEngine + SyncClient + libsodium) against the
 * REAL Rails API and Postgres, for the guards around WHO may sync WHAT:
 *  - a device whose Vault Key differs from the account's vault (it created a new
 *    vault instead of restoring) never uploads anything (QA DEFECT-C1);
 *  - a 401 or 403 on pull stops sync, clears the token and signs the device out,
 *    exactly like on push (QA DEFECT-H3).
 * Separate from two-clients.test.ts so its sign-ins get their own passkey throttle
 * window (10/min per IP) on a freshly booted API.
 *
 * Run: npx tsx --test --test-concurrency=1 tests/sync-e2e/account-guards.test.ts
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootApi, psql, RP_ID, WEB_ORIGIN, type RunningApi } from './api-harness.ts';
import { SoftwareAuthenticator, type ExportedCredential } from './software-authenticator.ts';
import { Client } from './helpers.ts';
import { wireItemId } from '../../packages/sync/src/index.ts';

const PASS = 'account guards passphrase 1';
const OTHER_PASS = 'a different vault entirely 2';
const EMAIL = `sync-guards-${Date.now()}@example.test`;
const id = (n: string) => `item_${n.padEnd(24, '0').slice(0, 24)}`;
const ID = { a: id('ga1'), c: id('gc1'), gone: id('gd1'), live: id('ge1'), purgeRunning: id('gf1') };
const M = { a: 'GUARD-A-1a1a', c: 'GUARD-C-OTHER-KEY-2b2b', gone: 'GUARD-GONE-3c3c', live: 'GUARD-LIVE-4d4d', purgeRunning: 'GUARD-PURGE-RUNNING-5e5e' };
const nodeSha = async (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const wire = (local: string) => wireItemId(local, nodeSha);
const serverItem = (w: string) => psql(`SELECT current_revision, (deleted_at IS NOT NULL) FROM items WHERE id='${w}'`);
const RETRY_MS = 400; // client-worker default

let api: RunningApi;
let A: Client;
let C: Client;
let D: Client;
let authenticator: ExportedCredential;
let backup: string;
const dir = mkdtempSync(path.join(tmpdir(), 'sync-guards-'));

before(async () => {
  api = await bootApi();
  A = new Client('A', path.join(dir, 'a.json')).start();
  C = new Client('C', path.join(dir, 'c.json')).start();
  D = new Client('D', path.join(dir, 'd.json')).start();
});
after(async () => {
  for (const c of [A, C, D]) await c?.kill();
  await api?.stop();
});

async function waitFor<T>(label: string, fn: () => Promise<T | false | undefined | null>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const settled = (c: Client) => waitFor(`${c.name} idle with nothing pending`, async () => {
  const s = await c.call('status');
  return s.state === 'idle' && s.pending === 0 ? s : false;
});
async function signIn(c: Client) {
  const r = await c.call('signIn', { email: EMAIL, authenticator });
  authenticator = r.authenticator;
}
const deviceOf = async (c: Client) => (await c.call<Record<string, string>>('rawStorage'))['sync-e2e.device-id'];
const tokenDigest = async (c: Client) => createHash('sha256').update((await c.call<Record<string, string>>('rawStorage'))['sync-e2e.token']).digest('hex');
const counts = () => psql('SELECT (SELECT count(*) FROM vaults), (SELECT count(*) FROM items), (SELECT count(*) FROM sync_events)');
const localRow = async (c: Client, localId: string) =>
  (JSON.parse((await c.call<Record<string, string>>('rawStorage'))['my-secrect.local-vault.v1'] ?? '[]') as any[]).find((r) => r.id === localId);

test('A registers, creates the account vault and syncs an item', async () => {
  authenticator = SoftwareAuthenticator.create(WEB_ORIGIN, RP_ID).exportCredential();
  assert.equal((await A.call('register', { email: EMAIL, authenticator })).signedIn, true);
  await A.call('createVault', { passphrase: PASS });
  backup = await A.call<string>('exportBackup');
  assert.equal(await A.call('unlock', { passphrase: PASS }), true);
  await A.call('startSync');
  await A.call('createItem', { id: ID.a, title: M.a, fields: { notes: 'v1' } });
  assert.equal((await A.call('syncNow')).state, 'idle');
  assert.equal(counts(), '1|1|1');
  assert.ok(psql('SELECT length(encrypted_metadata) FROM vaults').length > 0, 'the vault carries a key check');
});

test('DEFECT-C1: a device that created its OWN vault signs in -> vault_mismatch, nothing uploaded, A unaffected', async () => {
  await C.call('createVault', { passphrase: OTHER_PASS });
  assert.equal(await C.call('unlock', { passphrase: OTHER_PASS }), true);
  await C.call('createItem', { id: ID.c, title: M.c, fields: { notes: 'encrypted under a different Vault Key' } });
  await signIn(C);
  const before = counts();
  const st = await C.call('startSync');
  assert.equal(st.state, 'vault_mismatch', JSON.stringify(st));
  assert.match(st.error, /does not match your account's vault/);
  assert.match(st.error, /nothing was uploaded/);
  assert.match(st.error, /restore it from a backup/);
  assert.equal(counts(), before, 'no vault, item or event was created');
  assert.equal(psql(`SELECT count(*) FROM sync_events WHERE device_id='${await deviceOf(C)}'`), '0');
  assert.equal(psql(`SELECT count(*) FROM items WHERE id='${await wire(ID.c)}'`), '0');
  // Halted, not retrying: still refused after several retry periods, still nothing sent.
  await new Promise((r) => setTimeout(r, RETRY_MS * 4));
  assert.equal((await C.call('syncNow')).state, 'vault_mismatch');
  assert.equal(counts(), before);
  // A keeps syncing cleanly; nothing undecryptable reached it.
  const a = await A.call('syncNow');
  assert.equal(a.state, 'idle', JSON.stringify(a));
  assert.deepEqual((await A.call<any[]>('list')).map((i) => i.title), [M.a]);
});

test('DEFECT-C1 remedy: the same account on a device that RESTORED the backup syncs normally', async () => {
  await D.call('restoreBackup', { json: backup, passphrase: PASS });
  await signIn(D);
  assert.equal(await D.call('unlock', { passphrase: PASS }), true);
  await D.call('startSync');
  await settled(D);
  assert.equal((await D.find(M.a))?.id, ID.a);
});

test('DEFECT-H3: a 401 on PULL stops sync, clears the token and signs the device out', async () => {
  await settled(A);
  assert.equal((await A.call('status')).pending, 0, 'nothing queued: the pull is the first request to fail');
  psql(`UPDATE sessions SET revoked_at = now() WHERE token_digest='${await tokenDigest(A)}'`);
  const st = await A.call('syncNow');
  assert.equal(st.state, 'signed_out', JSON.stringify(st));
  assert.match(st.error, /Sign-in expired \(401\)/);
  assert.deepEqual(await A.call('session'), { hasToken: false, unauthorizedCalls: 1 });
  await new Promise((r) => setTimeout(r, RETRY_MS * 4));
  assert.equal((await A.call('status')).state, 'signed_out', 'no retry loop with a dead session');
  // Signing in again resumes sync.
  await signIn(A);
  await A.call('startSync');
  await settled(A);
});

test('DEFECT-H3: a 403 device_not_authorized on PULL is treated the same way', async () => {
  await settled(A);
  psql(`UPDATE devices SET revoked_at = now() WHERE id='${await deviceOf(A)}'`); // session itself still live
  const st = await A.call('syncNow');
  assert.equal(st.state, 'signed_out', JSON.stringify(st));
  assert.match(st.error, /no longer authorized to sync \(403\)/);
  assert.deepEqual(await A.call('session'), { hasToken: false, unauthorizedCalls: 2 }, 'second sign-out of this client process');
  await new Promise((r) => setTimeout(r, RETRY_MS * 4));
  assert.equal((await A.call('status')).state, 'signed_out');
});
