// Imports the real packages/core/src/sharing.ts module and real libsodium.
// Nothing in the module under test is mocked. The VaultCipher below is the
// same construction as apps/*/src/vault.ts encryptWithVaultKey (XChaCha20-
// Poly1305 under a 32-byte Vault Key, nonce || ciphertext) built from the
// real crypto-adapters; the real vault module is exercised end to end in
// tests/sharing-e2e.
// Run: npx tsx --test packages/core/tests/sharing-proposal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, libsodiumAdapter, sodiumReady, toBase64 } from '../../crypto-adapters/src/index.ts';
import {
  IdentityError,
  KeyChangedError,
  KeyNotVerifiedError,
  PinStore,
  ShareCryptoError,
  WRAPPED_SHARE_KEY_BYTES,
  decryptIdentity,
  decryptOwnerMetadata,
  decryptShareRecord,
  encryptIdentity,
  encryptOwnerMetadata,
  encryptShareRecord,
  fingerprint,
  generateIdentityKeyPair,
  mergeSharedEdit,
  newShareId,
  pinStorageKey,
  toSharedItem,
  verifyShareKey,
} from '../src/sharing.ts';

await sodiumReady;

function vaultCipher() {
  const key = libsodiumAdapter.randomBytes(32);
  return {
    async encrypt(text) {
      const { nonce, ciphertext } = await libsodiumAdapter.encrypt(key, new TextEncoder().encode(text));
      const out = new Uint8Array(nonce.length + ciphertext.length);
      out.set(nonce);
      out.set(ciphertext, nonce.length);
      return toBase64(out);
    },
    async decrypt(encoded) {
      const bytes = fromBase64(encoded);
      const pt = await libsodiumAdapter.decrypt(key, bytes.subarray(0, 24), bytes.subarray(24));
      return new TextDecoder().decode(pt);
    },
  };
}

function memoryStore() {
  const m = new Map();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const item = {
  id: 'item_0123456789abcdef',
  type: 'login',
  schema_version: 1,
  title: 'Shared router',
  fields: { username: 'admin', password: 'MARK-pw-7f3a' },
  tags: ['home'],
  relations: [{ type: 'has_login', target_id: 'item_secret_graph' }],
  attachments: ['blob_private'],
  favorite: true,
  created_at: '2026-11-17T00:00:00.000Z',
  updated_at: '2026-11-17T00:00:00.000Z',
};

function flip(b64, index) {
  const bytes = fromBase64(b64);
  bytes[index] ^= 0x01;
  return toBase64(bytes);
}

const owner = await generateIdentityKeyPair();
const recipient = await generateIdentityKeyPair();
const stranger = await generateIdentityKeyPair();

test('identity: the secret key round-trips only under the same Vault Key and registered public key', async () => {
  const vault = vaultCipher();
  const encrypted = await encryptIdentity(owner, vault);
  assert.ok(!encrypted.includes(toBase64(owner.secretKey)), 'secret key is not visible in the ciphertext');
  const opened = await decryptIdentity(encrypted, toBase64(owner.publicKey), vault);
  assert.deepEqual(opened.publicKey, owner.publicKey);
  assert.deepEqual(opened.secretKey, owner.secretKey);

  await assert.rejects(decryptIdentity(encrypted, toBase64(owner.publicKey), vaultCipher()), IdentityError);
  await assert.rejects(decryptIdentity(encrypted, toBase64(stranger.publicKey), vault), IdentityError);
  const wrongKind = await vault.encrypt(JSON.stringify({ kind: 'device-name', public_key: toBase64(owner.publicKey), secret_key: toBase64(owner.secretKey) }));
  await assert.rejects(decryptIdentity(wrongKind, toBase64(owner.publicKey), vault), IdentityError);
  const mismatched = await vault.encrypt(JSON.stringify({ kind: 'my-secrect.sharing.identity.v1', public_key: toBase64(owner.publicKey), secret_key: toBase64(stranger.secretKey) }));
  await assert.rejects(decryptIdentity(mismatched, toBase64(owner.publicKey), vault), IdentityError);
  await assert.rejects(decryptIdentity(flip(encrypted, 30), toBase64(owner.publicKey), vault), IdentityError);
});

test('fingerprint: 30 digits derived from BLAKE2b-256 of the domain-separated key', async () => {
  const fp = await fingerprint(owner.publicKey);
  assert.match(fp, /^\d{5}( \d{5}){5}$/);
  assert.equal(await fingerprint(owner.publicKey), fp, 'deterministic');
  assert.notEqual(await fingerprint(recipient.publicKey), fp);
  // Independent derivation of the digit groups (BigInt), same hash input.
  const input = new Uint8Array([...new TextEncoder().encode('my-secrect:sharing:fingerprint:v1'), ...owner.publicKey]);
  const hash = sodium.crypto_generichash(32, input, null);
  const expected = [0, 1, 2, 3, 4, 5].map((g) => {
    let v = 0n;
    for (const byte of hash.subarray(g * 5, g * 5 + 5)) v = (v << 8n) | BigInt(byte);
    return (v % 100000n).toString().padStart(5, '0');
  }).join(' ');
  assert.equal(fp, expected);
  await assert.rejects(fingerprint(new Uint8Array(31)), ShareCryptoError);
});

test('record: recipient decrypts the owner revision; the owner can read it too; private fields are stripped', async () => {
  const shareId = await newShareId();
  const rec = await encryptShareRecord(item, { shareId, revision: 1, self: owner, peerPublicKey: recipient.publicKey });
  assert.equal(fromBase64(rec.encrypted_item_key).length, WRAPPED_SHARE_KEY_BYTES);
  assert.ok(!Buffer.from(fromBase64(rec.encrypted_payload)).toString('latin1').includes('MARK-pw-7f3a'));

  const byRecipient = await decryptShareRecord(rec, { shareId, revision: 1, self: recipient, peerPublicKey: owner.publicKey });
  assert.deepEqual(byRecipient, toSharedItem(item));
  assert.equal(byRecipient.fields.password, 'MARK-pw-7f3a');
  assert.deepEqual(byRecipient.relations, []);
  assert.deepEqual(byRecipient.attachments, []);
  assert.equal('favorite' in byRecipient, false);

  const byOwner = await decryptShareRecord(rec, { shareId, revision: 1, self: owner, peerPublicKey: recipient.publicKey });
  assert.deepEqual(byOwner, byRecipient);
  await verifyShareKey(rec.encrypted_item_key, recipient, owner.publicKey);
});

test('record: a recipient write (box from recipient) opens for the owner; every revision has a fresh key', async () => {
  const shareId = await newShareId();
  const r1 = await encryptShareRecord(item, { shareId, revision: 1, self: owner, peerPublicKey: recipient.publicKey });
  const edited = { ...toSharedItem(item), title: 'Edited by recipient' };
  const r2 = await encryptShareRecord(edited, { shareId, revision: 2, self: recipient, peerPublicKey: owner.publicKey });
  assert.notEqual(r1.encrypted_item_key, r2.encrypted_item_key);
  const seen = await decryptShareRecord(r2, { shareId, revision: 2, self: owner, peerPublicKey: recipient.publicKey });
  assert.equal(seen.title, 'Edited by recipient');
  const again = await encryptShareRecord(item, { shareId, revision: 1, self: owner, peerPublicKey: recipient.publicKey });
  assert.notEqual(again.encrypted_payload, r1.encrypted_payload, 'fresh key + nonce on every encryption');
});

test('record: tampered wrapped key, tampered payload, wrong recipient and moved records all fail closed', async () => {
  const shareId = await newShareId();
  const rec = await encryptShareRecord(item, { shareId, revision: 3, self: owner, peerPublicKey: recipient.publicKey });
  const ctx = { shareId, revision: 3, self: recipient, peerPublicKey: owner.publicKey };

  for (const index of [0, 23, 24, 50, WRAPPED_SHARE_KEY_BYTES - 1]) {
    await assert.rejects(decryptShareRecord({ ...rec, encrypted_item_key: flip(rec.encrypted_item_key, index) }, ctx), ShareCryptoError, `wrapped key byte ${index}`);
    await assert.rejects(verifyShareKey(flip(rec.encrypted_item_key, index), recipient, owner.publicKey), ShareCryptoError);
  }
  await assert.rejects(decryptShareRecord({ ...rec, encrypted_item_key: toBase64(fromBase64(rec.encrypted_item_key).subarray(0, 71)) }, ctx), ShareCryptoError);
  await assert.rejects(decryptShareRecord({ ...rec, encrypted_payload: flip(rec.encrypted_payload, 40) }, ctx), ShareCryptoError);
  await assert.rejects(decryptShareRecord({ ...rec, encrypted_payload: flip(rec.encrypted_payload, 5) }, ctx), ShareCryptoError);

  // Wrong recipient: a third key pair cannot open the wrap, whoever it trusts.
  await assert.rejects(decryptShareRecord(rec, { ...ctx, self: stranger }), ShareCryptoError);
  await assert.rejects(decryptShareRecord(rec, { ...ctx, self: stranger, peerPublicKey: recipient.publicKey }), ShareCryptoError);

  // Same pair, but the server moved the record to another share or revision.
  await assert.rejects(decryptShareRecord(rec, { ...ctx, shareId: await newShareId() }), ShareCryptoError);
  await assert.rejects(decryptShareRecord(rec, { ...ctx, revision: 2 }), ShareCryptoError);
});

test('record: a server-forged share (box made with an attacker key) does not open under the pinned owner key', async () => {
  // Why crypto_box_easy and not a sealed box: anyone with B's public key can
  // make a sealed box. A box made by an attacker key pair does not open
  // under (pinned owner key, recipient secret).
  const attacker = await generateIdentityKeyPair();
  const shareId = await newShareId();
  const forged = await encryptShareRecord({ ...item, title: 'Forged' }, { shareId, revision: 1, self: attacker, peerPublicKey: recipient.publicKey });
  await assert.rejects(verifyShareKey(forged.encrypted_item_key, recipient, owner.publicKey), ShareCryptoError);
  await assert.rejects(decryptShareRecord(forged, { shareId, revision: 1, self: recipient, peerPublicKey: owner.publicKey }), ShareCryptoError);
});

test('pins: unverified and changed keys are refused; pins persist encrypted per account and fail closed when tampered', async () => {
  const vault = vaultCipher();
  const store = memoryStore();
  const pins = await PinStore.open(store, 'user-A', vault);
  const real = toBase64(recipient.publicKey);
  const substituted = toBase64(stranger.publicKey);

  await assert.rejects(pins.requireVerified('user-B', real), KeyNotVerifiedError);
  assert.equal(pins.state('user-B', real), 'unverified');
  const pinned = await pins.pin({ user_id: 'user-B', email: 'b@example.test', public_key: real });
  assert.equal(pinned.fingerprint, await fingerprint(recipient.publicKey));
  assert.deepEqual(await pins.requireVerified('user-B', real), recipient.publicKey);
  assert.equal(pins.state('user-B', real), 'verified');

  const changed = await pins.requireVerified('user-B', substituted).catch((e) => e);
  assert.ok(changed instanceof KeyChangedError);
  assert.equal(changed.pinnedFingerprint, await fingerprint(recipient.publicKey));
  assert.equal(changed.presentedFingerprint, await fingerprint(stranger.publicKey));
  assert.equal(pins.state('user-B', substituted), 'changed');
  await assert.rejects(pins.pin({ user_id: 'user-B', email: 'b@example.test', public_key: substituted }), KeyChangedError);

  const raw = store.m.get(pinStorageKey('user-A'));
  assert.ok(raw && !raw.includes('b@example.test') && !raw.includes(real), 'pins are stored encrypted');
  const reopened = await PinStore.open(store, 'user-A', vault);
  assert.deepEqual(await reopened.requireVerified('user-B', real), recipient.publicKey);

  await assert.rejects(PinStore.open(store, 'user-A', vaultCipher()), IdentityError);
  store.m.set(pinStorageKey('user-A'), flip(raw, 30));
  await assert.rejects(PinStore.open(store, 'user-A', vault), IdentityError);
  store.m.set(pinStorageKey('user-C'), raw);
  await assert.rejects(PinStore.open(store, 'user-C', vault), IdentityError, "another account's pin file is refused");
  await PinStore.reset(store, 'user-A');
  assert.equal((await PinStore.open(store, 'user-A', vault)).list().length, 0);

  await reopened.forget('user-B');
  await assert.rejects(reopened.requireVerified('user-B', real), KeyNotVerifiedError);
  await reopened.pin({ user_id: 'user-B', email: 'b@example.test', public_key: substituted });
  assert.equal(reopened.state('user-B', substituted), 'verified');
});

test('owner metadata opens only under the owner Vault Key and for the share it names', async () => {
  const vault = vaultCipher();
  const shareId = await newShareId();
  const enc = await encryptOwnerMetadata(shareId, item.id, vault);
  assert.deepEqual(await decryptOwnerMetadata(enc, shareId, vault), { source_item_id: item.id });
  await assert.rejects(decryptOwnerMetadata(enc, await newShareId(), vault), ShareCryptoError);
  await assert.rejects(decryptOwnerMetadata(enc, shareId, vaultCipher()), ShareCryptoError);
});

test('newShareId is a UUID v4; mergeSharedEdit keeps the vault item identity and private fields', async () => {
  const id = await newShareId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(await newShareId(), id);
  const shared = { ...toSharedItem(item), id: 'item_other', type: 'secure_note', title: 'New title', fields: { password: 'new' }, tags: ['x'] };
  const merged = mergeSharedEdit(item, shared, '2026-11-18T00:00:00.000Z');
  assert.equal(merged.id, item.id);
  assert.equal(merged.type, 'login');
  assert.deepEqual(merged.relations, item.relations);
  assert.deepEqual(merged.attachments, item.attachments);
  assert.equal(merged.favorite, true);
  assert.equal(merged.title, 'New title');
  assert.deepEqual(merged.fields, { password: 'new' });
  assert.deepEqual(merged.tags, ['x']);
  assert.equal(merged.updated_at, '2026-11-18T00:00:00.000Z');
});
