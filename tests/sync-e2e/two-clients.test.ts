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
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApi, pgDump, psql, PORT, RP_ID, WEB_ORIGIN, type RunningApi } from './api-harness.ts';
import { SoftwareAuthenticator, type ExportedCredential } from './software-authenticator.ts';
import { Client } from './helpers.ts';
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
  lost: 'MARK-LOST-india-1a2b', lostEdit: 'MARK-LOST-EDIT-3c4d', lostAfter: 'MARK-LOST-AFTER-5e6f',
  lostA: 'MARK-LOST-A-7a8b', lostB: 'MARK-LOST-B-9c0d', fault: 'MARK-FAULT-juliet-2e3f',
  bothDel: 'MARK-BOTHDEL-kilo-4a5b',
};
const ALL_MARKERS = Object.values(M);

const id = (n: string) => `item_${n.padEnd(24, '0').slice(0, 24)}`;
const ID = { one: id('a1'), two: id('b2'), three: id('c3'), del: id('d4'), dvu: id('e5'), lvr: id('f6'), tamper: id('a7'), offline: id('b8'), lost: id('c9'), fault: id('d0'), bothDel: id('e1') };
const nodeSha = async (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const wire = (local: string) => wireItemId(local, nodeSha); // independent SHA-256 (node:crypto)

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
/** Server-side history of one item: "revision:operation" per sync event, and its stored versions. */
const serverLog = (w: string) => ({
  events: psql(`SELECT revision || ':' || operation FROM sync_events WHERE item_id='${w}' ORDER BY sequence`).split('\n').filter(Boolean),
  versions: psql(`SELECT revision FROM item_versions WHERE item_id='${w}' ORDER BY revision`).split('\n').filter(Boolean).map(Number),
});
const settled = async (c: Client, label: string) => waitFor(`${label} idle with nothing pending`, async () => {
  const s = await c.call('status');
  return s.state === 'idle' && s.pending === 0 ? s : false;
});
const openConflicts = async (c: Client) => (await c.call<any[]>('conflicts')).filter((x) => x.resolution === 'unresolved');

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
  // The server commits before it answers: give A the moment to process the reply.
  await waitFor('A queue drained', async () => (await A.call('status')).pending === 0);
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

test('INTERRUPTED: push response lost -> the automatic retry is a replay: one revision, one event, nothing lost', async () => {
  await A.call('createItem', { id: ID.lost, title: M.lost, fields: { notes: 'v1' } });
  await A.call('syncNow'); await B.call('syncNow');
  const w = await wire(ID.lost);
  assert.equal(serverItem(w), '1|f');
  const lostBefore = await A.call<number>('lostResponses');
  await A.call('loseResponses', { match: '/sync/push', count: 1 });
  await A.call('editItem', { id: ID.lost, title: M.lostEdit });
  await A.call('syncNow');
  assert.equal(await A.call<number>('lostResponses'), lostBefore + 1, 'the reply to the push was lost after the server answered');
  assert.deepEqual(serverLog(w), { events: ['1:upsert', '2:upsert'], versions: [1, 2] }, 'the server did store the edit');
  // To A the lost reply was a dead connection, so the edit stayed queued and the engine
  // retries it by itself with the same ciphertext and base 1: the server answers with the
  // stored revision 2 instead of a 409 or a duplicate.
  await settled(A, 'A after the retry');
  assert.deepEqual(serverLog(w), { events: ['1:upsert', '2:upsert'], versions: [1, 2] }, 'no duplicate event or version');
  assert.equal((await openConflicts(A)).length, 0);
  // Not stuck: A's next edit is based on revision 2 and is accepted as 3.
  await A.call('editItem', { id: ID.lost, title: M.lostAfter });
  assert.equal((await A.call('syncNow')).state, 'idle');
  assert.equal(serverItem(w), '3|f');
  await B.call('syncNow');
  assert.equal((await B.find(M.lostAfter))?.id, ID.lost);
  assert.equal((await openConflicts(B)).length, 0);
});

test('INTERRUPTED: response lost, then B writes on top before A retries -> no false conflict, A ends on B\'s version', async () => {
  const w = await wire(ID.lost);
  await A.call('loseResponses', { match: '/sync/push', count: 1, thenOffline: true });
  await A.call('editItem', { id: ID.lost, title: M.lostA });
  assert.equal((await A.call('syncNow')).state, 'offline');
  assert.equal(serverItem(w), '4|f', 'A\'s edit reached the server as revision 4');
  await B.call('syncNow');
  assert.equal((await B.find(M.lostA))?.id, ID.lost, 'B pulled A\'s edit');
  await B.call('editItem', { id: ID.lost, title: M.lostB });
  assert.equal((await B.call('syncNow')).state, 'idle');
  assert.equal(serverItem(w), '5|f');
  // A comes back and retries its base-3 push: the server recognises revision 4 as that same
  // write, A advances to 4 and then pulls B's revision 5 cleanly — B built on A's edit.
  await A.call('setOnline', { online: true });
  await settled(A, 'A after reconnecting');
  assert.equal((await openConflicts(A)).length, 0, 'no conflict between A and its own accepted edit');
  assert.equal((await A.call<any[]>('list')).find((i) => i.id === ID.lost).title, M.lostB);
  assert.deepEqual(serverLog(w).events, ['1:upsert', '2:upsert', '3:upsert', '4:upsert', '5:upsert']);
});

test('INTERRUPTED: the server fails mid-push (500) -> nothing partial stored, the edit stays queued and lands once', async () => {
  await A.call('createItem', { id: ID.fault, title: M.fault, fields: { notes: 'v1' } });
  assert.equal((await A.call('syncNow')).state, 'idle');
  const w = await wire(ID.fault);
  const before = serverLog(w);
  assert.deepEqual(before, { events: ['1:upsert'], versions: [1] });
  // A real failure inside the push transaction: the item row and the version are written,
  // then the sync event INSERT raises.
  psql(`CREATE FUNCTION e2e_injected_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$`);
  psql(`CREATE TRIGGER e2e_injected_fault BEFORE INSERT ON sync_events FOR EACH ROW EXECUTE FUNCTION e2e_injected_fault()`);
  try {
    await A.call('editItem', { id: ID.fault, title: `${M.fault}-edit` });
    const st = await A.call('syncNow');
    assert.equal(st.state, 'error', JSON.stringify(st));
    assert.match(st.error, /500/);
    assert.equal(st.pending, 1, 'the edit stays queued');
    assert.deepEqual(serverLog(w), before, 'no version without an event, no revision bump');
    assert.equal(serverItem(w), '1|f');
  } finally {
    psql('DROP FUNCTION IF EXISTS e2e_injected_fault() CASCADE');
  }
  await settled(A, 'A once the server works again');
  assert.deepEqual(serverLog(w), { events: ['1:upsert', '2:upsert'], versions: [1, 2] }, 'landed exactly once');
  await B.call('syncNow');
  assert.equal((await B.find(`${M.fault}-edit`))?.id, ID.fault);
});

test('both devices delete the same item offline -> one tombstone, both clean, no conflict', async () => {
  await A.call('createItem', { id: ID.bothDel, title: M.bothDel, fields: { notes: 'v1' } });
  await A.call('syncNow'); await B.call('syncNow');
  const w = await wire(ID.bothDel);
  await A.call('setOnline', { online: false });
  await B.call('setOnline', { online: false });
  await A.call('deleteItem', { id: ID.bothDel });
  await B.call('deleteItem', { id: ID.bothDel });
  await waitFor('both deletes queued', async () => (await A.call('status')).pending === 1 && (await B.call('status')).pending === 1);
  await B.call('setOnline', { online: true });
  await B.call('syncNow');
  await settled(B, 'B');
  assert.deepEqual(serverLog(w).events, ['1:upsert', '2:delete']);
  await A.call('setOnline', { online: true });
  await A.call('syncNow');
  await settled(A, 'A (its delete from the same base returns B\'s tombstone)');
  assert.deepEqual(serverLog(w).events, ['1:upsert', '2:delete'], 'exactly one tombstone');
  for (const c of [A, B]) {
    assert.ok((await c.find(M.bothDel))?.deleted_at, `${c.name}: in trash, restorable`);
    assert.equal((await openConflicts(c)).length, 0);
  }
});

test('a session holder without the vault key cannot roll an item back by re-pushing old ciphertext', async () => {
  const w = await wire(ID.lost);
  const token = (await B.call<Record<string, string>>('rawStorage'))['sync-e2e.token'];
  const vaultId = psql(`SELECT vault_id FROM items WHERE id='${w}'`);
  const old = psql(`SELECT encode(encrypted_payload,'base64'), encode(encrypted_item_key,'base64') FROM item_versions WHERE item_id='${w}' AND revision=1`)
    .replace(/\n/g, '').split('|');
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/vaults/${vaultId}/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ item_id: w, base_revision: 5, operation: 'upsert', encrypted_payload: old[0], encrypted_item_key: old[1], encryption_version: 1 }),
  });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'ciphertext_reuse', revision: 1 });
  assert.equal(serverItem(w), '5|f', 'nothing written');
  await A.call('syncNow');
  assert.equal((await A.call<any[]>('list')).find((i) => i.id === ID.lost).title, M.lostB, 'A still shows the current version');
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
