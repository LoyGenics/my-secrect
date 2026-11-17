/**
 * Acceptance K (sync pull leg) + C/D (wrong-key device) on the real stack.
 *
 * Real Rails API + Postgres (lib/stack.ts); devices are real Node clients
 * (tests/sync-e2e/client-worker.ts: desktop vault module + SyncEngine + SDK +
 * libsodium; WebAuthn verified by the API). The SERVER is the attacker or the
 * corruption source here: ciphertext is altered in Postgres with psql, exactly
 * what a compromised database or a buggy storage layer would serve.
 *
 * tests/sync-e2e/two-clients.test.ts already covers a flipped payload byte.
 * This file adds: flipped wrapped-item-key byte, truncated payload, payloads
 * swapped between two items, an authentic OLDER ciphertext replayed as a newer
 * revision (rollback), and a device that holds a different vault key.
 *
 * Fail-safe contract for every case: the bad event is not applied, the local
 * item is unchanged, the failure is visible in sync status, and the client
 * recovers once the server serves intact data again.
 *
 * Run: npx tsx --test --test-concurrency=1 tests/acceptance/sync-integrity.e2e.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApi, type RunningApi } from './lib/stack.ts';
import { SoftwareAuthenticator, type ExportedCredential } from '../sync-e2e/software-authenticator.ts';
import { Client } from '../sync-e2e/helpers.ts';
import { wireItemId } from '../../packages/sync/src/index.ts';

const API_PORT = Number(process.env.ACCEPT_K_API_PORT ?? 3254);
const ORIGIN = `http://localhost:${process.env.ACCEPT_K_WEB_PORT ?? 5366}`; // WebAuthn origin only; no web server needed
const DB = 'vault_k_a15_e2eauth';
const PASS = 'acceptance K passphrase 2';
const EMAIL = `k-sync-${Date.now()}@example.test`;
const defect = (id: string) => (process.env.ACCEPTANCE_STRICT ? undefined : id);
const lid = (s: string) => `item_${s.padEnd(32, '0')}`;
const X = lid('k0a'), Y = lid('k0b'), Z = lid('k0c'), R = lid('k0d');
const wire = (local: string) => wireItemId(local, async (b) => new Uint8Array(createHash('sha256').update(b).digest()));

let api: RunningApi;
let A: Client;
let B: Client;
let C: Client | null = null;
let cred: ExportedCredential;
const dir = mkdtempSync(path.join(tmpdir(), 'accept-k-'));
const env = () => ({ API_BASE: api.apiBase, WEBAUTHN_ORIGIN: ORIGIN, WEBAUTHN_RP_ID: 'localhost', MAIL_DIR: api.mailDir });

const hex = (w: string, rev: number, col: 'encrypted_payload' | 'encrypted_item_key') =>
  api.psql(`SELECT encode(${col},'hex') FROM item_versions WHERE item_id='${w}' AND revision=${rev}`);
const setHex = (w: string, rev: number, col: 'encrypted_payload' | 'encrypted_item_key', h: string) =>
  api.psql(`UPDATE item_versions SET ${col}=decode('${h}','hex') WHERE item_id='${w}' AND revision=${rev}`);
const flipHex = (h: string, byte: number) => { const b = Buffer.from(h, 'hex'); b[byte] ^= 0x01; return b.toString('hex'); };
const item = async (c: Client, id: string) => (await c.call<any[]>('list')).find((i) => i.id === id);

/** B's engine pulls on its own (retry/push timers). Keep it offline while A
 *  writes and the "server" alters rows, so B only ever sees the final state. */
async function whileBOffline(fn: () => Promise<void>) {
  await B.call('setOnline', { online: false });
  try { await fn(); } finally { await B.call('setOnline', { online: true }); }
}

async function signIn(c: Client) {
  const si = await c.call('signIn', { email: EMAIL, authenticator: cred });
  cred = si.authenticator; // keep the advancing sign counter (clone detection is real)
}

before(async () => {
  api = await startApi({ port: API_PORT, db: DB, webOrigin: ORIGIN });
  A = new Client('A', path.join(dir, 'a.json')).start(env());
  B = new Client('B', path.join(dir, 'b.json')).start(env());
});
after(async () => {
  await A?.kill(); await B?.kill(); await C?.kill();
  await api?.stop();
});

test('setup: A and B share the vault (B joined by restoring A\'s backup) and are in sync', async () => {
  cred = SoftwareAuthenticator.create(ORIGIN, 'localhost').exportCredential();
  await A.call('register', { email: EMAIL, authenticator: cred });
  await A.call('createVault', { passphrase: PASS });
  const backup = await A.call<string>('exportBackup');
  await A.call('unlock', { passphrase: PASS });
  await A.call('startSync');
  for (const [id, title] of [[X, 'K-X v1'], [Y, 'K-Y v1'], [Z, 'K-Z v1'], [R, 'K-R v1']]) {
    await A.call('createItem', { id, title, fields: { password: `${title}-pw` } });
  }
  assert.equal((await A.call('syncNow')).state, 'idle');
  await B.call('restoreBackup', { json: backup, passphrase: PASS });
  await signIn(B);
  await B.call('unlock', { passphrase: PASS });
  await B.call('startSync');
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.deepEqual((await B.titles()), ['K-R v1', 'K-X v1', 'K-Y v1', 'K-Z v1']);
});

test('K3 tampered wrapped item key: rejected, not applied, reported every run, recovers when intact', async () => {
  const w = await wire(Z);
  let good = '';
  await whileBOffline(async () => {
    await A.call('editItem', { id: Z, title: 'K-Z v2' });
    assert.equal((await A.call('syncNow')).state, 'idle');
    good = hex(w, 2, 'encrypted_item_key');
    setHex(w, 2, 'encrypted_item_key', flipHex(good, 30));
  });
  for (let run = 0; run < 2; run++) {
    const st = await B.call('syncNow');
    assert.equal(st.state, 'error', JSON.stringify(st));
    assert.match(st.error, /item .*:/);
    assert.equal((await item(B, Z)).title, 'K-Z v1', 'local item unchanged');
  }
  setHex(w, 2, 'encrypted_item_key', good);
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal((await item(B, Z)).title, 'K-Z v2');
});

test('K2 corrupted (truncated) ciphertext: rejected, not applied, recovers when intact', async () => {
  const w = await wire(Z);
  let good = '';
  await whileBOffline(async () => {
    await A.call('editItem', { id: Z, title: 'K-Z v3' });
    assert.equal((await A.call('syncNow')).state, 'idle');
    good = hex(w, 3, 'encrypted_payload');
    setHex(w, 3, 'encrypted_payload', good.slice(0, 60)); // 30 bytes: nonce + 6 bytes
  });
  const st = await B.call('syncNow');
  assert.equal(st.state, 'error', JSON.stringify(st));
  assert.equal((await item(B, Z)).title, 'K-Z v2');
  setHex(w, 3, 'encrypted_payload', good);
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal((await item(B, Z)).title, 'K-Z v3');
});

test('K3 authentic ciphertexts swapped between two items: id binding rejects both, neither item overwritten', async () => {
  const wx = await wire(X), wy = await wire(Y);
  let px = '', kx = '', py = '', ky = '';
  await whileBOffline(async () => {
    await A.call('editItem', { id: X, title: 'K-X v2' });
    await A.call('editItem', { id: Y, title: 'K-Y v2' });
    assert.equal((await A.call('syncNow')).state, 'idle');
    px = hex(wx, 2, 'encrypted_payload'); kx = hex(wx, 2, 'encrypted_item_key');
    py = hex(wy, 2, 'encrypted_payload'); ky = hex(wy, 2, 'encrypted_item_key');
    setHex(wx, 2, 'encrypted_payload', py); setHex(wx, 2, 'encrypted_item_key', ky);
    setHex(wy, 2, 'encrypted_payload', px); setHex(wy, 2, 'encrypted_item_key', kx);
  });
  const st = await B.call('syncNow');
  assert.equal(st.state, 'error', JSON.stringify(st));
  assert.match(st.error, /does not belong to this event/);
  assert.equal((await item(B, X)).title, 'K-X v1');
  assert.equal((await item(B, Y)).title, 'K-Y v1');
  setHex(wx, 2, 'encrypted_payload', px); setHex(wx, 2, 'encrypted_item_key', kx);
  setHex(wy, 2, 'encrypted_payload', py); setHex(wy, 2, 'encrypted_item_key', ky);
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal((await item(B, X)).title, 'K-X v2');
  assert.equal((await item(B, Y)).title, 'K-Y v2');
});

test('K3 rollback: an authentic OLDER ciphertext served as a newer revision is detected, not applied', { todo: defect('DEFECT-K3-rollback: the item plaintext carries no revision and event signatures are not verified, so the server can replay an old version as a new revision; specs/threat-model.md:10 claims "AEAD, signed events, trusted checkpoints" against rollback') }, async () => {
  await A.call('editItem', { id: R, title: 'K-R v2 (current password)' });
  assert.equal((await A.call('syncNow')).state, 'idle');
  await B.call('syncNow');
  assert.equal((await item(B, R)).title, 'K-R v2 (current password)');
  const w = await wire(R);
  await whileBOffline(async () => {
    await A.call('editItem', { id: R, title: 'K-R v3 (rotated password)' });
    assert.equal((await A.call('syncNow')).state, 'idle');
    // Malicious server: revision 3 now carries revision 1's authentic ciphertext.
    setHex(w, 3, 'encrypted_payload', hex(w, 1, 'encrypted_payload'));
    setHex(w, 3, 'encrypted_item_key', hex(w, 1, 'encrypted_item_key'));
  });
  const st = await B.call('syncNow');
  const title = (await item(B, R)).title;
  assert.notEqual(title, 'K-R v1', `B silently rolled the item back to revision 1's content (sync state: ${st.state}${st.error ? `, error: ${st.error}` : ''})`);
  assert.equal(st.state, 'error', 'rollback must be reported');
});

test('wrong vault key (C created its own vault instead of restoring): nothing undecryptable is applied, A\'s data is intact, failures are visible', async () => {
  C = new Client('C', path.join(dir, 'c.json')).start(env());
  await C.call('createVault', { passphrase: 'a different passphrase 3' });
  await signIn(C);
  await C.call('unlock', { passphrase: 'a different passphrase 3' });
  await C.call('createItem', { id: lid('k0e'), title: 'K-C foreign-key item', fields: { password: 'c' } });
  const stC = await C.call('startSync');
  const stC2 = await C.call('syncNow');
  // C1 fix: the engine detects the foreign Vault Key before any push and halts in an explicit state.
  assert.equal(stC2.state, 'vault_mismatch', `C cannot read the account vault: ${JSON.stringify(stC2)} (start: ${JSON.stringify(stC)})`);
  assert.deepEqual(await C.titles(), ['K-C foreign-key item'], 'C applied nothing it could not decrypt');
  const before = await A.titles();
  const stA = await A.call('syncNow');
  assert.deepEqual(await A.titles(), before, 'A\'s items unchanged; the foreign item is not applied');
  if (api.psql(`SELECT count(*) FROM items WHERE id='${await wire(lid('k0e'))}'`) === '1') {
    assert.equal(stA.state, 'error', 'A must surface the undecryptable event, not skip it silently');
  }
});

test('a device whose vault key cannot open the account vault refuses to push into it', async () => {
  const w = await wire(lid('k0e'));
  assert.equal(api.psql(`SELECT count(*) FROM items WHERE id='${w}'`), '0', 'C\'s item (encrypted under a different vault key) reached the shared vault');
  const stA = await A.call('syncNow');
  assert.equal(stA.state, 'idle', `A's sync is stuck: ${stA.error}`);
});
