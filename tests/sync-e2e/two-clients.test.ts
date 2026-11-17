/**
 * Two REAL clients against a RUNNING real Rails API + Postgres.
 *
 *   client A, client B = separate processes (client-worker.ts), each with its own
 *   persisted localStorage, running the real desktop vault module, real SDK,
 *   real SyncClient (via the desktop SyncEngine) and real libsodium crypto.
 *   Account auth = real WebAuthn ceremony (software authenticator) verified by
 *   the API's `webauthn` gem. Nothing about the sync path is mocked; the only
 *   simulated thing is connectivity (fetch rejects while a client is "offline").
 *
 * Run: npx tsx --test --test-concurrency=1 tests/sync-e2e/two-clients.test.ts
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { bootApi, pgDump, psql, PORT, RP_ID, WEB_ORIGIN, type RunningApi } from './api-harness.ts';
import { SoftwareAuthenticator, type ExportedCredential } from './software-authenticator.ts';
import { wireItemId } from '../../packages/sync/src/index.ts';
import { SecurityApiClient } from '../../packages/sdk/src/security.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASS = 'correct horse battery staple 1';
const EMAIL = `sync-e2e-${Date.now()}@example.test`;

// Plaintext markers that must NEVER reach the server, its DB or its log.
const M = {
  titleA: 'MARK-TITLE-alpha-7f3a', pwA: 'MARK-PW-alpha-91c2',
  titleB: 'MARK-TITLE-bravo-2d8e', pwB: 'MARK-PW-bravo-55b0',
  note: 'MARK-NOTE-charlie-0e11',
  editB: 'MARK-EDIT-B-4c4c', editA: 'MARK-EDIT-A-8a8a',
  del: 'MARK-DEL-delta-3b3b', dvu: 'MARK-DVU-echo-6d6d', dvuEdit: 'MARK-DVU-EDIT-1f1f',
  lvr: 'MARK-LVR-foxtrot-9e9e', lvrEdit: 'MARK-LVR-EDIT-2a2a',
  tamper: 'MARK-TAMPER-golf-7c7c', offline: 'MARK-OFFLINE-hotel-5e5e',
};
const ALL_MARKERS = Object.values(M);

const id = (n: string) => `item_${n.padEnd(24, '0').slice(0, 24)}`;
const ID = { one: id('a1'), two: id('b2'), three: id('c3'), del: id('d4'), dvu: id('e5'), lvr: id('f6'), tamper: id('a7'), offline: id('b8') };
const nodeSha = async (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const wire = (local: string) => wireItemId(local, nodeSha); // independent SHA-256 (node:crypto)

class Client {
  private child!: ChildProcess;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  private ready!: Promise<void>;
  constructor(readonly name: string, readonly stateFile: string) {}
  start(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'client-worker.ts')], {
      env: { ...process.env, CLIENT_STATE_FILE: this.stateFile, WEBAUTHN_ORIGIN: WEB_ORIGIN, WEBAUTHN_RP_ID: RP_ID, API_BASE: `http://127.0.0.1:${PORT}/api`, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.ready) return resolveReady();
      this.pending.get(m.seq)?.(m);
      this.pending.delete(m.seq);
    });
    return this;
  }
  async call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    const seq = ++this.seq;
    const reply = new Promise<any>((r) => this.pending.set(seq, r));
    this.child.stdin!.write(JSON.stringify({ seq, cmd, args }) + '\n');
    const m = await reply;
    if (!m.ok) throw Object.assign(new Error(`${this.name}.${cmd}: ${m.error}`), { status: m.status });
    return m.result as T;
  }
  async kill() {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((r) => { this.child.once('exit', () => r()); this.child.kill('SIGKILL'); });
  }
  titles = async () => (await this.call<any[]>('list')).filter((i) => !i.deleted_at).map((i) => i.title).sort();
  find = async (title: string) => (await this.call<any[]>('list')).find((i) => i.title === title);
}

let api: RunningApi;
let A: Client;
let B: Client;
let authenticator: ExportedCredential;
const dir = mkdtempSync(path.join(tmpdir(), 'sync-e2e-'));

before(async () => {
  api = await bootApi();
  A = new Client('A', path.join(dir, 'a.json')).start();
  B = new Client('B', path.join(dir, 'b.json')).start();
});
after(async () => {
  await A?.kill();
  await B?.kill();
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
const serverItem = (w: string) => psql(`SELECT current_revision, (deleted_at IS NOT NULL) FROM items WHERE id='${w}'`);

test('account auth: real WebAuthn registration; server rejects a forged assertion', async () => {
  const soft = SoftwareAuthenticator.create(WEB_ORIGIN, RP_ID);
  authenticator = soft.exportCredential();
  const reg = await A.call('register', { email: EMAIL, authenticator });
  assert.equal(reg.signedIn, true);
  // The server really verifies: a corrupted signature must be refused (401), no session issued.
  const sec = new SecurityApiClient({ baseUrl: `http://127.0.0.1:${PORT}/api`, getToken: async () => null });
  const opts: any = await sec.passkeyAuthenticateOptions(EMAIL);
  const forged = SoftwareAuthenticator.importCredential(authenticator, WEB_ORIGIN, RP_ID).get(opts.request_options.challenge, { corruptSignature: true });
  await assert.rejects(() => sec.passkeyLoginVerify(EMAIL, forged), (e: any) => e.status === 401);
  assert.equal(psql(`SELECT count(*) FROM authenticators`), '1');
});

test('A creates the vault, unlocks, syncs: server vault + items stored as ciphertext only', async () => {
  const created = await A.call('createVault', { passphrase: PASS });
  assert.ok(created.recoveryKey);
  // Backup of the EMPTY vault = the key envelope B uses to join (fresh-device restore).
  const backup = await A.call<string>('exportBackup');
  (globalThis as any).__backup = backup;
  assert.equal(await A.call('unlock', { passphrase: PASS }), true);
  await A.call('startSync');
  await A.call('createItem', { id: ID.one, title: M.titleA, fields: { username: 'alice', password: M.pwA } });
  await A.call('createItem', { id: ID.two, title: 'note-two', type: 'secure_note', fields: { notes: M.note } });
  const st = await A.call('syncNow');
  assert.equal(st.state, 'idle', `A status: ${JSON.stringify(st)}`);
  assert.equal(st.pending, 0);
  assert.equal(psql(`SELECT count(*) FROM vaults`), '1');
  // wire ids are the UUID mapping of the local ids; revision 1 after first push
  assert.equal(serverItem(await wire(ID.one)), '1|f');
  assert.equal(serverItem(await wire(ID.two)), '1|f');
  // stored payloads are ciphertext: ≥ 24B nonce + 16B tag, not JSON, no plaintext markers
  const rows = psql(`SELECT length(encrypted_payload), encode(encrypted_payload,'escape') ~ '^\\{' FROM item_versions`).split('\n');
  assert.equal(rows.length, 2);
  for (const r of rows) { const [len, looksJson] = r.split('|'); assert.ok(Number(len) > 40); assert.equal(looksJson, 'f'); }
});

test('B joins (restore of the empty backup), signs in with the same passkey, pulls A\'s items decrypted', async () => {
  const backup = (globalThis as any).__backup as string;
  await B.call('restoreBackup', { json: backup, passphrase: PASS });
  // The API throttles /auth/passkeys* to 10/min per IP (Rack::Attack) and test 1 already used most of it.
  // Wait out the window on 429 instead of weakening the server.
  let si: any;
  for (let attempt = 0; ; attempt++) {
    try { si = await B.call('signIn', { email: EMAIL, authenticator }); break; }
    catch (e: any) {
      if (attempt >= 2 || !/429|rate_limited/.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 61_000));
    }
  }
  authenticator = si.authenticator;
  assert.equal(await B.call('unlock', { passphrase: PASS }), true);
  await B.call('startSync');
  const st = await B.call('syncNow');
  assert.equal(st.state, 'idle', `B status: ${JSON.stringify(st)}`);
  const list = await B.call<any[]>('list');
  assert.equal(list.length, 2);
  const one = list.find((i) => i.id === ID.one);
  assert.equal(one.title, M.titleA);
  assert.equal(one.fields.password, M.pwA);
  assert.equal(psql(`SELECT count(*) FROM vaults`), '1', 'B joined the existing server vault, did not create another');
});

test('edit on B (base_revision 1 -> revision 2) reaches A; no conflict', async () => {
  await B.call('editItem', { id: ID.one, title: M.editB });
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal(serverItem(await wire(ID.one)), '2|f');
  assert.equal(psql(`SELECT count(*) FROM item_versions WHERE item_id='${await wire(ID.one)}'`), '2', 'append-only history kept');
  await A.call('syncNow');
  assert.equal((await A.find(M.editB))?.id, ID.one);
  assert.equal((await A.call<any[]>('conflicts')).length, 0);
});

test('delete on A becomes a tombstone; B moves it to trash (restorable, not erased)', async () => {
  await A.call('createItem', { id: ID.del, title: M.del, fields: { notes: 'to be deleted' } });
  await A.call('syncNow');
  await B.call('syncNow');
  assert.equal((await B.find(M.del))?.deleted_at, null);
  await A.call('deleteItem', { id: ID.del });
  const st = await A.call('syncNow');
  assert.equal(st.state, 'idle', JSON.stringify(st));
  assert.equal(serverItem(await wire(ID.del)), '2|t');
  assert.equal(psql(`SELECT operation FROM sync_events WHERE item_id='${await wire(ID.del)}' ORDER BY sequence DESC LIMIT 1`), 'delete');
  assert.equal(psql(`SELECT count(*) FROM item_versions WHERE item_id='${await wire(ID.del)}'`), '1', 'last ciphertext kept for restore');
  await B.call('syncNow');
  const onB = await B.find(M.del);
  assert.ok(onB?.deleted_at, 'B has the item in trash');
  // restore on B syncs back as an upsert (base = delete revision)
  await B.call('restoreItem', { id: ID.del });
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal(serverItem(await wire(ID.del)), '3|f');
  await A.call('syncNow');
  assert.equal((await A.find(M.del))?.deleted_at, null);
});

test('offline queue survives a reload and is pushed automatically when the network returns', async () => {
  await A.call('setOnline', { online: false });
  await A.call('createItem', { id: ID.offline, title: M.offline, fields: { notes: 'made offline' } });
  await waitFor('A to report offline with a queued change', async () => {
    const s = await A.call('status');
    return s.state === 'offline' && s.pending === 1 ? s : false;
  });
  assert.equal(psql(`SELECT count(*) FROM items WHERE id='${await wire(ID.offline)}'`), '0', 'nothing reached the server while offline');
  // Reload: kill the process, start a fresh one on the same persisted state, still offline.
  await A.kill();
  A = new Client('A', path.join(dir, 'a.json')).start({ START_OFFLINE: '1' });
  assert.equal(await A.call('unlock', { passphrase: PASS }), true);
  const s0 = await A.call('startSync');
  assert.notEqual(s0.state, 'idle');
  const s1 = await waitFor('A queue restored after reload', async () => {
    const s = await A.call('status');
    if (process.env.DEBUG_SYNC) console.error('A after reload', JSON.stringify(s));
    return s.state === 'offline' && s.pending === 1 ? s : false;
  });
  assert.equal(s1.pending, 1, 'queued change persisted across reload');
  // Back online: the engine retries by itself (no manual sync).
  await A.call('setOnline', { online: true });
  await waitFor('retry pushed the queued item', async () => serverItem(await wire(ID.offline)) === '1|f');
  assert.equal((await A.call('status')).pending, 0);
  await B.call('syncNow');
  assert.equal((await B.find(M.offline))?.id, ID.offline);
});

test('CONFLICT: both edit offline -> stale 409 -> conflict stored (encrypted) with both versions -> Keep both loses nothing', async () => {
  await A.call('syncNow'); await B.call('syncNow');
  await A.call('setOnline', { online: false });
  await B.call('setOnline', { online: false });
  await A.call('editItem', { id: ID.one, title: M.editA, fields: { password: M.pwA + '-A2' } });
  await B.call('editItem', { id: ID.one, title: M.titleB, fields: { password: M.pwB } });
  await waitFor('both queued', async () => (await A.call('status')).pending === 1 && (await B.call('status')).pending === 1);
  // B reconnects first and wins the server revision (3 -> base was 2).
  await B.call('setOnline', { online: true });
  assert.equal((await B.call('syncNow')).state, 'idle');
  const revAfterB = serverItem(await wire(ID.one));
  assert.equal(revAfterB, '3|f');
  // A reconnects with a stale base_revision (2): the server must answer 409 and keep B's revision.
  await A.call('setOnline', { online: true });
  const st = await A.call('syncNow');
  assert.equal(serverItem(await wire(ID.one)), '3|f', 'server did NOT overwrite B with A (no LWW)');
  assert.ok(st.unresolvedConflicts >= 1, `A status: ${JSON.stringify(st)}`);
  const conflicts = await A.call<any[]>('conflicts');
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, 'same_item_both_changed');
  assert.equal(c.local.title, M.editA, 'both versions available after decrypt: local');
  assert.equal(c.local.fields.password, M.pwA + '-A2');
  assert.equal(c.remote.title, M.titleB, 'both versions available after decrypt: remote');
  assert.equal(c.remote.fields.password, M.pwB);
  // Local item is untouched while the conflict is open.
  assert.equal((await A.call<any[]>('list')).find((i) => i.id === ID.one).title, M.editA);
  // Conflict records hold decrypted data: they must be stored encrypted, never as plaintext.
  const raw = JSON.stringify(await A.call('rawStorage'));
  for (const m of [M.editA, M.titleB, M.pwB, M.pwA + '-A2']) assert.ok(!raw.includes(m), `plaintext ${m} found in A's localStorage`);
  assert.ok(!('my-secrect.sync.conflicts.v1' in (await A.call('rawStorage'))));
  assert.ok('my-secrect.sync.conflicts.enc.v1' in (await A.call('rawStorage')));
  // Resolve: keep both.
  const after = await A.call('keepBoth', { id: c.id });
  assert.equal(after.state, 'idle', JSON.stringify(after));
  assert.equal(after.unresolvedConflicts, 0);
  await B.call('syncNow'); await A.call('syncNow');
  for (const client of [A, B]) {
    const items = await client.call<any[]>('list');
    const mine = items.find((i) => i.id === ID.one);
    assert.equal(mine?.title, M.editA, `${client.name}: A's version kept at the original id`);
    assert.equal(mine?.fields.password, M.pwA + '-A2');
    const copy = items.find((i) => i.title === `${M.titleB} (conflict copy)`);
    assert.ok(copy, `${client.name}: B's version kept as a copy`);
    assert.equal(copy.fields.password, M.pwB);
    assert.notEqual(copy.id, ID.one);
  }
  // Keep-both is idempotent: resolving again creates nothing new.
  const count = (await A.call<any[]>('list')).length;
  await A.call('keepBoth', { id: c.id });
  assert.equal((await A.call<any[]>('list')).length, count);
});

test('DELETE vs UPDATE: remote delete + local edit -> conflict, Keep both keeps the edited item alive', async () => {
  await A.call('createItem', { id: ID.dvu, title: M.dvu, fields: { notes: 'v1' } });
  await A.call('syncNow'); await B.call('syncNow');
  await A.call('setOnline', { online: false });
  await A.call('editItem', { id: ID.dvu, title: M.dvuEdit });
  await B.call('deleteItem', { id: ID.dvu });
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal(serverItem(await wire(ID.dvu)), '2|t');
  await A.call('setOnline', { online: true });
  await A.call('syncNow');
  const cs = (await A.call<any[]>('conflicts')).filter((c) => c.local.id === ID.dvu && c.resolution === 'unresolved');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].kind, 'delete_vs_update');
  assert.equal(cs[0].local.title, M.dvuEdit);
  assert.equal(serverItem(await wire(ID.dvu)), '2|t', 'server still shows the delete: nothing silently resurrected');
  assert.equal((await A.find(M.dvuEdit))?.deleted_at, null, 'A\'s edit is still live locally');
  await A.call('keepBoth', { id: cs[0].id });
  assert.equal(serverItem(await wire(ID.dvu)), '3|f', 'edited item restored on the server');
  await B.call('syncNow');
  const onB = await B.find(M.dvuEdit);
  assert.equal(onB?.deleted_at, null, 'B now has the edited item back');
});

test('UPDATE vs local DELETE: B edits, A deletes offline -> conflict, Keep both preserves B\'s version as a copy', async () => {
  await A.call('createItem', { id: ID.lvr, title: M.lvr, fields: { notes: 'v1' } });
  await A.call('syncNow'); await B.call('syncNow');
  await A.call('setOnline', { online: false });
  await A.call('deleteItem', { id: ID.lvr });
  await B.call('editItem', { id: ID.lvr, title: M.lvrEdit });
  assert.equal((await B.call('syncNow')).state, 'idle');
  await A.call('setOnline', { online: true });
  const stLvr = await A.call('syncNow');
  if (process.env.DEBUG_SYNC) console.error('LVR A status', JSON.stringify(stLvr), JSON.stringify(await A.call('conflicts')));
  const cs = (await A.call<any[]>('conflicts')).filter((c) => c.local.id === ID.lvr && c.resolution === 'unresolved');
  assert.equal(cs.length, 1);
  assert.equal(serverItem(await wire(ID.lvr)), '2|f', 'B\'s edit is still on the server: A\'s delete did not win');
  await A.call('keepBoth', { id: cs[0].id });
  await B.call('syncNow'); await A.call('syncNow');
  for (const client of [A, B]) {
    const copy = await client.find(`${M.lvrEdit} (conflict copy)`);
    assert.ok(copy && copy.deleted_at === null, `${client.name}: B's edited version survives as a live copy`);
  }
  assert.equal(serverItem(await wire(ID.lvr)), '3|t', 'A\'s delete applied only after the explicit resolution');
});

test('a ciphertext that fails AEAD is reported with visible text, not applied, not skipped; recovers when fixed', async () => {
  await A.call('createItem', { id: ID.tamper, title: M.tamper, fields: { notes: 'integrity' } });
  await A.call('syncNow');
  const w = await wire(ID.tamper);
  const original = psql(`SELECT encode(encrypted_payload,'hex') FROM item_versions WHERE item_id='${w}'`);
  psql(`UPDATE item_versions SET encrypted_payload = set_byte(encrypted_payload, 30, (get_byte(encrypted_payload,30)+1)%256) WHERE item_id='${w}'`);
  const st = await B.call('syncNow');
  assert.equal(st.state, 'error', JSON.stringify(st));
  assert.match(st.error, /AEAD verification failed/);
  assert.equal(await B.find(M.tamper), undefined, 'tampered item not applied');
  const st2 = await B.call('syncNow');
  assert.equal(st2.state, 'error', 'still reported on the next run: the checkpoint is held, nothing is silently skipped');
  psql(`UPDATE item_versions SET encrypted_payload = decode('${original}','hex') WHERE item_id='${w}'`);
  const st3 = await B.call('syncNow');
  assert.equal(st3.state, 'idle', JSON.stringify(st3));
  assert.equal((await B.find(M.tamper))?.id, ID.tamper, 'after the ciphertext is intact again B applies it');
});

test('convergence + server stores ciphertext only (full DB dump and API log contain no plaintext)', async () => {
  for (let i = 0; i < 2; i++) { await A.call('syncNow'); await B.call('syncNow'); }
  const a = (await A.call<any[]>('list')).sort((x, y) => x.id.localeCompare(y.id));
  const b = (await B.call<any[]>('list')).sort((x, y) => x.id.localeCompare(y.id));
  // Live items must be identical. A deleted (trash) item keeps whichever last version each device held
  // (A: the version it deleted, B: the newer remote edit); that is trash content, not a live divergence.
  const shape = (l: any[]) => l.map((i) => [i.id, i.deleted_at ? '(trash)' : i.title, !!i.deleted_at]);
  assert.deepEqual(shape(a), shape(b), 'A and B converge');
  assert.equal((await A.call('status')).pending, 0);
  assert.equal((await B.call('status')).pending, 0);
  assert.equal((await A.call<any[]>('conflicts')).filter((c) => c.resolution === 'unresolved').length, 0);
  const dump = pgDump();
  const log = readFileSync(api.logPath, 'utf8');
  for (const m of ALL_MARKERS) {
    assert.ok(!dump.includes(m), `plaintext marker ${m} found in the database dump`);
    assert.ok(!dump.includes(Buffer.from(m).toString('hex')), `hex marker ${m} found in the database dump`);
    assert.ok(!log.includes(m), `plaintext marker ${m} found in the API log`);
  }
  // sanity: the dump is a real dump (contains our tables' rows), so the absence above is meaningful
  assert.ok(dump.includes('INSERT INTO public.item_versions'));
  assert.ok(Number(psql('SELECT count(*) FROM item_versions')) >= 10);
});
