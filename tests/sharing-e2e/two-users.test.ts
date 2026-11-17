/**
 * Sharing end to end: REAL users against the REAL Rails API + Postgres.
 *
 *   Each device is its own process (user-worker.ts) running the real desktop
 *   vault module, the real SDK (SharingSession — the same calls SharesView and
 *   SharesScreen make) and real libsodium. Accounts sign up exactly as on
 *   main: emailed code (read from the API's :file mail delivery) -> ticket ->
 *   real WebAuthn ceremony the API verifies; identity-key registration and
 *   rotation need a real passkey step-up. The only thing this test does that
 *   a user would not is play the MALICIOUS SERVER through psql: substituting
 *   a key, relabelling an email, tampering ciphertext, forging a share,
 *   moving a wrapped key between shares.
 *
 *   A = owner (alice), B = recipient (bob), C = third user (carol),
 *   A2 = A's second device (restored from A's vault backup),
 *   A3 = a device of A's account with a separately created vault.
 *
 * Run: npx tsx --test --test-concurrency=1 tests/sharing-e2e/two-users.test.ts
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, pgDump, psql, type RunningApi } from './api-harness.ts';
import { UserDevice, rejectsWith } from './helpers.ts';

const PASS = { A: 'alice correct horse battery 10', B: 'bob correct horse battery 10', C: 'carol correct horse battery 10' };
const stamp = Date.now();
const EMAIL = { A: `alice-${stamp}@example.test`, B: `bob-${stamp}@example.test`, C: `carol-${stamp}@example.test` };
// Plaintext markers that must never reach the server, its database or its log.
const M = {
  title: 'MARK-SHARE-TITLE-a1b2', pw: 'MARK-SHARE-PW-c3d4', title2: 'MARK-SHARE-TITLE2-e5f6', pw2: 'MARK-SHARE-PW2-0b0b',
  edit: 'MARK-SHARE-EDIT-B-7a7a', latest: 'MARK-SHARE-LATEST-A-9f9f', forged: 'MARK-FORGED-1d1d', readonlyWrite: 'MARK-RO-WRITE-2e2e',
  reviewed: 'MARK-REVIEWED-R4-3c3c', unreviewed: 'MARK-UNREVIEWED-R5-4d4d', pin: 'MARK-PIN-5e5e',
};
const ITEM1 = 'item_share_e2e_read_000001';
const ITEM2 = 'item_share_e2e_write_00002';

let api: RunningApi;
const A = new UserDevice('A');
const B = new UserDevice('B');
const C = new UserDevice('C');
const A2 = new UserDevice('A2');
const A3 = new UserDevice('A3');
const who: Record<'A' | 'B' | 'C', { userId: string; publicKey: string; fingerprint: string }> = {} as any;
/** Latest state of A's (synced) passkey: the server requires its counter to grow. */
let passkeyA: unknown;
let backupA = '';
let readShareId = '';
let writeShareId = '';

before(async () => {
  api = await bootApi();
  for (const d of [A, B, C, A2, A3]) d.start();
});
after(async () => {
  await Promise.all([A, B, C, A2, A3].map((d) => d.kill()));
  await api?.stop();
});

const sql = (s: string) => psql(s);
const shareRow = (id: string) => sql(`SELECT status, revision, permission, octet_length(encrypted_item_key), octet_length(encrypted_payload), encrypted_payload IS NULL FROM item_shares WHERE id='${id}'`);

test('enrol: three users sign up (email code + passkey), create vaults and register identity keys after a step-up', async () => {
  for (const [name, dev] of [['A', A], ['B', B], ['C', C]] as const) {
    await dev.call('register', { email: EMAIL[name] });
    await dev.call('createVault', { passphrase: PASS[name] });
    if (name === 'A') {
      // L2: registering the identity key needs a fresh step-up; nothing is stored without it.
      const denied = await rejectsWith(dev.call('startSharing'), 'ApiError', 403);
      assert.match(denied.message, /step_up_required/);
      assert.equal(sql('SELECT count(*) FROM identity_keys'), '0');
    }
    const stepped = await dev.call('stepUp');
    if (name === 'A') passkeyA = stepped.authenticator;
    who[name] = await dev.call('startSharing');
    assert.match(who[name].fingerprint, /^\d{5}( \d{5}){5}$/);
  }
  backupA = await A.call('exportBackup');
  assert.equal(sql('SELECT count(*) FROM identity_keys'), '3');
  for (const name of ['A', 'B', 'C'] as const) {
    const [pkLen, pk, secretLen] = sql(`SELECT octet_length(public_key), translate(encode(public_key,'base64'), E'\\n', ''), octet_length(encrypted_secret_key) FROM identity_keys WHERE user_id='${who[name].userId}'`).split('|');
    assert.equal(pkLen, '32');
    assert.equal(pk, who[name].publicKey, 'server stores exactly the client public key');
    assert.ok(Number(secretLen) > 100, 'the secret key is stored only as Vault-Key ciphertext');
  }
  // Restarting sharing on the same device loads the identity, it does not make a new one.
  assert.deepEqual(await A.call('startSharing'), who.A);
  assert.equal(sql('SELECT count(*) FROM identity_keys'), '3');
});

test("multi-device: A's second device (vault restored from backup) loads the SAME identity; a device with another vault fails closed", async () => {
  await A2.call('restoreBackup', { json: backupA, passphrase: PASS.A });
  assert.equal(await A2.call('unlock', { passphrase: PASS.A }), true);
  passkeyA = (await A2.call('signIn', { email: EMAIL.A, authenticator: passkeyA })).authenticator;
  assert.deepEqual(await A2.call('startSharing'), who.A, 'loading an existing identity needs no step-up');

  await A3.call('createVault', { passphrase: 'a different vault for the same account' });
  passkeyA = (await A3.call('signIn', { email: EMAIL.A, authenticator: passkeyA })).authenticator;
  await rejectsWith(A3.call('startSharing'), 'IdentityError');
  assert.equal(sql(`SELECT count(*) FROM identity_keys WHERE user_id='${who.A.userId}'`), '1', 'no second identity was registered');
});

test('verification: the looked-up fingerprint equals what B sees on its own device; an unverified key cannot be used', async () => {
  await A.call('createItem', { id: ITEM1, title: M.title, fields: { username: 'alice', password: M.pw } });
  const contact = await A.call('lookup', { email: EMAIL.B });
  assert.equal(contact.user_id, who.B.userId);
  assert.equal(contact.pinState, 'unverified');
  assert.equal(contact.fingerprint, who.B.fingerprint, 'out-of-band comparison: both screens show the same 30 digits');
  await rejectsWith(A.call('shareItem', { itemId: ITEM1, contact, permission: 'read', expiresAt: null }), 'KeyNotVerifiedError');
  assert.equal(sql('SELECT count(*) FROM item_shares'), '0');
  await A.call('verifyContact', { contact });
  assert.equal((await A.call('lookup', { email: EMAIL.B })).pinState, 'verified');
});

test('server key substitution: B\'s key swapped for another key is caught by the pin, nothing is shared', async () => {
  sql(`UPDATE identity_keys SET public_key = decode('${who.C.publicKey}', 'base64') WHERE user_id='${who.B.userId}'`);
  try {
    const contact = await A.call('lookup', { email: EMAIL.B });
    assert.equal(contact.pinState, 'changed');
    assert.equal(contact.fingerprint, who.C.fingerprint);
    assert.equal(contact.pinnedFingerprint, who.B.fingerprint);
    await rejectsWith(A.call('shareItem', { itemId: ITEM1, contact, permission: 'read', expiresAt: null }), 'KeyChangedError');
    assert.equal(sql('SELECT count(*) FROM item_shares'), '0');
  } finally {
    sql(`UPDATE identity_keys SET public_key = decode('${who.B.publicKey}', 'base64') WHERE user_id='${who.B.userId}'`);
  }
});

test('A shares read-only; B verifies A, checks the key exchange, accepts, and decrypts the exact plaintext', async () => {
  const contact = await A.call('lookup', { email: EMAIL.B });
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const created = await A.call('shareItem', { itemId: ITEM1, contact, permission: 'read', expiresAt });
  readShareId = created.id;
  assert.equal(created.status, 'pending');
  // 104 bytes = format v2 wrap (Share Key || SHA-256 binding, boxed)
  assert.equal(shareRow(readShareId), 'pending|1|read|104|' + sql(`SELECT octet_length(encrypted_payload) FROM item_shares WHERE id='${readShareId}'`) + '|f');

  const [incoming] = (await B.call<any[]>('listShares')).filter((s) => s.id === readShareId);
  assert.equal(incoming.role, 'recipient');
  assert.equal(incoming.owner.email, EMAIL.A);
  assert.equal(incoming.encrypted_owner_metadata, null);

  // Pending: the server withholds the payload; B cannot open, and cannot accept before verifying A.
  assert.equal((await B.call('rawGetRecord', { shareId: readShareId })).encrypted_payload, null);
  await rejectsWith(B.call('open', { shareId: readShareId }), 'KeyNotVerifiedError');
  await rejectsWith(B.call('accept', { shareId: readShareId }), 'KeyNotVerifiedError');
  assert.equal(shareRow(readShareId).split('|')[0], 'pending');

  const ownerContact = await B.call('lookup', { email: EMAIL.A });
  assert.equal(ownerContact.fingerprint, who.A.fingerprint);
  await B.call('verifyContact', { contact: ownerContact });
  await rejectsWith(B.call('open', { shareId: readShareId }), 'ShareCryptoError'); // still pending: no payload
  assert.equal(await B.call('verifyIncoming', { shareId: readShareId }), true);
  assert.equal((await B.call('accept', { shareId: readShareId })).status, 'active');

  const opened = await B.call('open', { shareId: readShareId });
  const original = await A.call('item', { id: ITEM1 });
  assert.equal(opened.revision, 1);
  assert.equal(opened.lastWriter, 'owner');
  assert.equal(opened.item.title, M.title);
  assert.equal(opened.item.fields.password, M.pw);
  assert.deepEqual(
    { id: opened.item.id, type: opened.item.type, title: opened.item.title, fields: opened.item.fields, tags: opened.item.tags },
    { id: original.id, type: original.type, title: original.title, fields: original.fields, tags: original.tags },
  );
  assert.deepEqual(opened.item.relations, [], "the owner's private item graph is not shared");
  assert.ok(original.relations.length > 0);
});

test('B (read-only) write attempt is rejected by the server and changes nothing', async () => {
  const err = await rejectsWith(B.call('edit', { shareId: readShareId, title: M.readonlyWrite }), 'ApiError', 403);
  assert.match(err.message, /write_not_permitted/);
  assert.equal(shareRow(readShareId).split('|').slice(0, 2).join('|'), 'active|1');
  assert.equal((await B.call('open', { shareId: readShareId })).item.title, M.title);
  assert.equal(sql(`SELECT count(*) FROM audit_events WHERE event_type='share_record_written'`), '0');
});

test('write share: B edits, A sees who wrote it, saves it explicitly, sends a later version; stale writes are 409', async () => {
  await A.call('createItem', { id: ITEM2, title: M.title2, fields: { username: 'alice2', password: M.pw2 } });
  const created = await A.call('shareItem', { itemId: ITEM2, contact: await A.call('lookup', { email: EMAIL.B }), permission: 'write', expiresAt: null });
  writeShareId = created.id;
  await B.call('accept', { shareId: writeShareId });

  assert.equal(await B.call('edit', { shareId: writeShareId, title: M.edit }), 2);
  const seenByA = await A.call('open', { shareId: writeShareId });
  assert.equal(seenByA.item.title, M.edit);
  assert.equal(seenByA.lastWriter, 'recipient');
  assert.equal((await A.call('item', { id: ITEM2 })).title, M.title2, "a recipient edit never reaches the owner's vault by itself");

  const saved = await A.call('saveToVault', { shareId: writeShareId });
  assert.equal(saved.id, ITEM2);
  const vaultItem = await A.call('item', { id: ITEM2 });
  assert.equal(vaultItem.title, M.edit);
  assert.ok(vaultItem.relations.length > 0, "the vault item's private relations are kept");

  await A.call('editItem', { id: ITEM2, fields: { notes: M.latest } });
  assert.equal(await A.call('sendLatest', { shareId: writeShareId }), 3);
  const seenByB = await B.call('open', { shareId: writeShareId });
  assert.equal(seenByB.revision, 3);
  assert.equal(seenByB.item.fields.notes, M.latest);
  assert.equal(seenByB.lastWriter, 'owner');

  const stale = await rejectsWith(B.call('writeAt', { shareId: writeShareId, baseRevision: 2, title: 'stale' }), 'ApiError', 409);
  assert.match(stale.message, /revision_conflict/);
  assert.equal(shareRow(writeShareId).split('|').slice(0, 2).join('|'), 'active|3');
});

test('tampered wrapped key or payload fails to decrypt; a wrong recipient key fails; a server-forged share is never accepted', async () => {
  // 1. Tamper the stored ciphertext (malicious server / bit rot).
  for (const column of ['encrypted_item_key', 'encrypted_payload']) {
    const original = sql(`SELECT encode(${column}, 'hex') FROM item_shares WHERE id='${writeShareId}'`);
    sql(`UPDATE item_shares SET ${column} = set_byte(${column}, 40, get_byte(${column}, 40) # 1) WHERE id='${writeShareId}'`);
    try {
      await rejectsWith(B.call('open', { shareId: writeShareId }), 'ShareCryptoError');
      await rejectsWith(A.call('open', { shareId: writeShareId }), 'ShareCryptoError');
    } finally {
      sql(`UPDATE item_shares SET ${column} = decode('${original}', 'hex') WHERE id='${writeShareId}'`);
    }
  }
  assert.equal((await B.call('open', { shareId: writeShareId })).revision, 3, 'restored ciphertext opens again');

  // 2. Wrong recipient: C has no access, and even with the raw ciphertext (taken
  //    straight from the database) and A's verified key, C's key pair cannot open it.
  await rejectsWith(C.call('rawGetRecord', { shareId: writeShareId }), 'ApiError', 404);
  const contactA = await C.call('lookup', { email: EMAIL.A });
  assert.equal(contactA.fingerprint, who.A.fingerprint);
  await C.call('verifyContact', { contact: contactA });
  const [payload, wrapped] = sql(`SELECT translate(encode(encrypted_payload,'base64'), E'\\n', ''), translate(encode(encrypted_item_key,'base64'), E'\\n', '') FROM item_shares WHERE id='${writeShareId}'`).split('|');
  await rejectsWith(C.call('decryptWith', { shareId: writeShareId, revision: 3, encrypted_payload: payload, encrypted_item_key: wrapped, peerUserId: who.A.userId, peerPublicKey: who.A.publicKey, peerEmail: EMAIL.A }), 'ShareCryptoError');
  // ...while B, the real recipient, opens the same bytes on a "fresh device" path.
  const sameBytes = await B.call('decryptWith', { shareId: writeShareId, revision: 3, encrypted_payload: payload, encrypted_item_key: wrapped, peerUserId: who.A.userId, peerPublicKey: who.A.publicKey, peerEmail: EMAIL.A });
  assert.equal(sameBytes.fields.notes, M.latest);

  // 3. A malicious server forges a pending share "from A" to B, encrypting with
  //    a key pair it controls (C's). B's key-exchange check refuses it.
  const forgedId = randomUUID();
  const contactB = await C.call('lookup', { email: EMAIL.B });
  await C.call('verifyContact', { contact: contactB });
  const now = new Date().toISOString();
  const forged = await C.call('encryptFor', {
    shareId: forgedId, revision: 1, peerUserId: who.B.userId, peerPublicKey: who.B.publicKey, peerEmail: EMAIL.B,
    item: { id: 'item_forged', type: 'login', schema_version: 1, title: M.forged, fields: { username: 'it-support', password: M.forged }, tags: [], relations: [], attachments: [], created_at: now, updated_at: now },
  });
  sql(`INSERT INTO item_shares (id, owner_id, recipient_id, permission, status, owner_public_key, recipient_public_key, revision, encrypted_payload, encrypted_item_key, encrypted_owner_metadata, last_writer_id, created_at, updated_at)
       VALUES ('${forgedId}', '${who.A.userId}', '${who.B.userId}', 'read', 'pending', decode('${who.A.publicKey}','base64'), decode('${who.B.publicKey}','base64'), 1,
               decode('${forged.encrypted_payload}','base64'), decode('${forged.encrypted_item_key}','base64'), decode('${forged.encrypted_payload}','base64'), '${who.A.userId}', now(), now())`);
  const listed = (await B.call<any[]>('listShares')).find((s) => s.id === forgedId);
  assert.equal(listed.owner.email, EMAIL.A, 'the forged share claims to come from A');
  await rejectsWith(B.call('verifyIncoming', { shareId: forgedId }), 'ShareCryptoError');
  await rejectsWith(B.call('accept', { shareId: forgedId }), 'ShareCryptoError');
  assert.equal(shareRow(forgedId).split('|')[0], 'pending', 'never activated');
  await B.call('revoke', { shareId: forgedId }); // B declines it
  assert.equal(shareRow(forgedId).split('|')[0], 'revoked');

  // 4. L4: the server copies a GENUINE wrap made by A for B (from the write
  //    share) into a forged pending share. The box opens with A's pinned key,
  //    but it is bound to the write share's id + revision, so B refuses it.
  const movedId = randomUUID();
  sql(`INSERT INTO item_shares (id, owner_id, recipient_id, permission, status, owner_public_key, recipient_public_key, revision, encrypted_payload, encrypted_item_key, encrypted_owner_metadata, last_writer_id, created_at, updated_at)
       SELECT '${movedId}', owner_id, recipient_id, 'read', 'pending', owner_public_key, recipient_public_key, revision, encrypted_payload, encrypted_item_key, encrypted_owner_metadata, owner_id, now(), now()
       FROM item_shares WHERE id='${writeShareId}'`);
  const moved = await rejectsWith(B.call('verifyIncoming', { shareId: movedId }), 'ShareCryptoError');
  assert.match(moved.message, /another share or revision/);
  await rejectsWith(B.call('accept', { shareId: movedId }), 'ShareCryptoError');
  assert.equal(shareRow(movedId).split('|')[0], 'pending', 'never activated');
});

test('M2: the owner saves exactly the revision they reviewed, never a newer unseen one', async () => {
  assert.equal(await B.call('edit', { shareId: writeShareId, title: M.reviewed }), 4);
  const shown = await A.call('open', { shareId: writeShareId }); // what A reviews on screen
  assert.equal(shown.revision, 4);
  assert.equal(shown.item.title, M.reviewed);
  assert.equal(await B.call('edit', { shareId: writeShareId, title: M.unreviewed }), 5); // written after A's review
  const saved = await A.call('saveToVault', { shareId: writeShareId });
  assert.equal(saved.title, M.reviewed);
  assert.equal((await A.call('item', { id: ITEM2 })).title, M.reviewed, 'revision 5 was never saved unseen');
  assert.equal(shareRow(writeShareId).split('|').slice(0, 2).join('|'), 'active|5');
});

test('M1: a malicious server relabelling a verified contact with another email is blocked like a key change', async () => {
  const ceo = `ceo-${stamp}@example.test`;
  sql(`UPDATE users SET email='${ceo}' WHERE id='${who.B.userId}'`);
  try {
    const peer = await A.call('peerView', { shareId: writeShareId });
    assert.deepEqual({ state: peer.state, serverEmail: peer.serverEmail, pinnedEmail: peer.pinnedEmail }, { state: 'relabeled', serverEmail: ceo, pinnedEmail: EMAIL.B });
    assert.notEqual(peer.email, EMAIL.B, 'a relabelled peer is never shown under the verified name');
    for (const cmd of ['open', 'sendLatest']) {
      const err = await rejectsWith(A.call(cmd, { shareId: writeShareId }), 'KeyChangedError');
      assert.match(err.message, /different email/);
    }
    const contact = await A.call('lookup', { email: ceo });
    assert.equal(contact.pinState, 'relabeled');
    assert.equal(contact.pinnedEmail, EMAIL.B);
    const before = sql('SELECT count(*) FROM item_shares');
    await rejectsWith(A.call('shareItem', { itemId: ITEM1, contact, permission: 'read', expiresAt: null }), 'KeyChangedError');
    assert.equal(sql('SELECT count(*) FROM item_shares'), before, 'nothing was shared to the relabelled contact');
  } finally {
    sql(`UPDATE users SET email='${EMAIL.B}' WHERE id='${who.B.userId}'`);
  }
  const restored = await A.call('peerView', { shareId: writeShareId });
  assert.deepEqual({ state: restored.state, email: restored.email }, { state: 'verified', email: EMAIL.B });
  assert.equal((await A.call('open', { shareId: writeShareId })).revision, 5);
});

test('L3: content with a forbidden field (PIN) is refused before encryption; nothing is written', async () => {
  const err = await rejectsWith(B.call('edit', { shareId: writeShareId, fields: { pin: M.pin } }), 'ShareContentError');
  assert.match(err.message, /forbidden field 'pin'/);
  assert.equal(shareRow(writeShareId).split('|').slice(0, 2).join('|'), 'active|5');
});

test('A revokes; B is denied and the server erased the ciphertext', async () => {
  await A.call('revoke', { shareId: readShareId });
  assert.equal(shareRow(readShareId), 'revoked|1|read|||t');
  const denied = await rejectsWith(B.call('open', { shareId: readShareId }), 'ApiError', 403);
  assert.match(denied.message, /share_revoked/);
  await rejectsWith(B.call('rawGetRecord', { shareId: readShareId }), 'ApiError', 403);
  await rejectsWith(B.call('edit', { shareId: readShareId, title: 'after revoke' }), 'ApiError', 403);
  const listed = (await B.call<any[]>('listShares')).find((s) => s.id === readShareId);
  assert.equal(listed.status, 'revoked');
  // The write share is unaffected.
  assert.equal((await B.call('open', { shareId: writeShareId })).revision, 5);
  assert.deepEqual(
    sql(`SELECT event_type FROM audit_events WHERE event_type LIKE 'share_%' ORDER BY created_at`).split('\n'),
    [
      'share_created', 'share_accepted', 'share_created', 'share_accepted', 'share_record_written', 'share_record_written',
      'share_revoked', // B declined the forged share
      'share_record_written', 'share_record_written', // M2: revisions 4 and 5
      'share_revoked', // A revoked the read share
    ],
  );
});

test('nothing the server stored or logged contains plaintext, keys or pins in the clear', async () => {
  const dump = pgDump();
  const log = api.railsLogSinceBoot();
  for (const marker of Object.values(M)) {
    assert.ok(!dump.includes(marker), `database contains ${marker}`);
    assert.ok(!log.includes(marker), `API log contains ${marker}`);
  }
  assert.ok(log.includes('Api::V1::SharesController'), 'the log really covers this run');
  // Pins are stored encrypted on the device: B's storage never shows A's email.
  const bStorage = (await B.call<string[]>('storageValues')).join('\n');
  assert.ok(!bStorage.includes(EMAIL.A));
  assert.ok(!bStorage.includes(M.pw));
});

test('L2: A resets the identity (step-up required); every share of A ends and B sees a key change', async () => {
  await A.call('adoptPasskey', { authenticator: passkeyA }); // synced passkey: latest counter from A3
  // The enrolment step-up is minutes old in this fast run; age it past the
  // 10-minute window, as real time would.
  sql(`UPDATE sessions SET step_up_verified_at = (now() at time zone 'utc') - interval '11 minutes' WHERE user_id='${who.A.userId}'`);
  const denied = await rejectsWith(A.call('resetIdentity'), 'ApiError', 403);
  assert.match(denied.message, /step_up_required/);
  assert.equal(sql(`SELECT translate(encode(public_key,'base64'), E'\\n', '') FROM identity_keys WHERE user_id='${who.A.userId}'`), who.A.publicKey);

  passkeyA = (await A.call('stepUp')).authenticator;
  const fresh = await A.call('resetIdentity');
  assert.equal(fresh.userId, who.A.userId);
  assert.notEqual(fresh.publicKey, who.A.publicKey);
  assert.notEqual(fresh.fingerprint, who.A.fingerprint);
  assert.equal(sql(`SELECT translate(encode(public_key,'base64'), E'\\n', '') FROM identity_keys WHERE user_id='${who.A.userId}'`), fresh.publicKey);
  assert.equal(sql(`SELECT count(*) FROM item_shares WHERE (owner_id='${who.A.userId}' OR recipient_id='${who.A.userId}') AND status <> 'revoked'`), '0');
  assert.equal(sql(`SELECT count(*) FROM item_shares WHERE (owner_id='${who.A.userId}' OR recipient_id='${who.A.userId}') AND encrypted_payload IS NOT NULL`), '0');
  assert.equal(sql(`SELECT metadata->>'revoked_shares' FROM audit_events WHERE event_type='identity_key_rotated'`), '2'); // write share + the moved-wrap forgery

  // Contacts see a key change and must verify again; nothing opens meanwhile.
  const seenByB = await B.call('lookup', { email: EMAIL.A });
  assert.equal(seenByB.pinState, 'changed');
  assert.equal(seenByB.fingerprint, fresh.fingerprint);
  assert.equal(seenByB.pinnedFingerprint, who.A.fingerprint);
  await rejectsWith(B.call('open', { shareId: writeShareId }), 'ApiError', 403);

  // A's other device with the same vault loads the new identity.
  assert.deepEqual(await A2.call('startSharing'), fresh);
});
