// Security rejection tests — PRODUCTION libsodium path.
// Plain Node 20+, no server, no TS loader.
//
// HONESTY NOTE — read before trusting a green run:
// * These tests exercise libsodium-wrappers-sumo DIRECTLY with the
//   adapter's exact production parameters (Argon2id INTERACTIVE for the
//   KEK; XChaCha20-Poly1305 IETF, 24-byte nonce, AEAD). They are the
//   complement to tamper.test.mjs / backup-corruption.test.mjs in this
//   folder, which mirror the WebCrypto REFERENCE adapter (AES-GCM +
//   PBKDF2) — not production crypto. Do not conflate the two files.
// * These tests CANNOT import the TypeScript adapter
//   (packages/crypto-adapters/src/index.ts) because `node --test` has no
//   TS loader, and the repo has no vitest/ts-node setup. The thin
//   envelope/binding rules from specs/encryption-format.md are
//   implemented inline in this file.
// * What a green run DOES prove: the underlying AEAD construction
//   rejects every tampering case below, and the envelope/binding rules
//   as specified reject mismatched metadata and replayed revisions.
// * What it does NOT prove: that the adapter module, vault.ts, or any
//   app actually calls these checks. The envelope + plaintext-binding
//   checks here are MIRRORS of the specified rules, not imports of
//   production code — a green run must not be presented as proof that
//   the apps enforce them. See docs/security-review.md M5.
// * Production AEAD uses NULL additional data (see
//   docs/security-review.md section 3), so metadata binding CANNOT come
//   from AAD (unlike the reference-mirror tests). It comes from the
//   item_id/revision fields INSIDE the plaintext — that is what the
//   replay/swap tests below check.
// * Nothing here is a bypass: every case asserts REJECTION (throws).
//   No test ever accepts a tampered, wrong-key, or replayed payload.
// * Run after `npm install` (needs libsodium-wrappers-sumo).
//   Command: node --test tests/security/
import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function ready() {
  await sodium.ready;
}

// --- Production-shaped helpers (mirror of specs/encryption-format.md) ---
// Stored envelope v1: { version: 1, nonce_b64, ciphertext_b64 } where the
// ciphertext is libsodium seal output (ciphertext || 16-byte tag).
// The plaintext is JSON: { item_id, revision, title, secret } — the
// item_id/revision INSIDE the plaintext are the binding the caller must
// check against the row's claimed values (AEAD has null AD in v1, so the
// envelope alone cannot bind metadata; the inner fields are the defense
// documented in docs/security-review.md section 3).
function sealEnvelope(key, plaintextObj) {
  const nonce = sodium.randombytes_buf(24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    enc.encode(JSON.stringify(plaintextObj)), null, null, nonce, key,
  );
  return {
    version: 1,
    nonce_b64: Buffer.from(nonce).toString('base64'),
    ciphertext_b64: Buffer.from(ct).toString('base64'),
  };
}

function openEnvelope(key, envelope, expectedItemId, expectedRevision) {
  // Envelope validation happens BEFORE any decryption attempt.
  if (!envelope || envelope.version !== 1) throw new Error('reject: unknown envelope version');
  const nonce = new Uint8Array(Buffer.from(envelope.nonce_b64, 'base64'));
  const ct = new Uint8Array(Buffer.from(envelope.ciphertext_b64, 'base64'));
  if (nonce.length !== 24) throw new Error('reject: bad nonce length');
  if (ct.length < 16) throw new Error('reject: ciphertext too short');
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
  const obj = JSON.parse(dec.decode(pt));
  // Plaintext binding: the decrypted item must be the item the row claims.
  if (obj.item_id !== expectedItemId) throw new Error('reject: item_id mismatch (swapped ciphertext)');
  if (obj.revision !== expectedRevision) throw new Error('reject: revision mismatch (replayed old version)');
  return obj;
}

async function kek(passphrase, salt) {
  await ready();
  return sodium.crypto_pwhash(
    32, enc.encode(passphrase), salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

const ITEM = { item_id: 'item-abc', revision: 3, title: 'bank', secret: 's3cret-value' };

test('invalid ciphertext is rejected (random bytes, not a seal)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const nonce = sodium.randombytes_buf(24);
  const garbage = sodium.randombytes_buf(64);
  assert.throws(
    () => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, garbage, null, nonce, key),
    /ciphertext|decrypt|invalid/i,
  );
});

test('invalid ciphertext is rejected (truncated seal)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const env = sealEnvelope(key, ITEM);
  const ct = new Uint8Array(Buffer.from(env.ciphertext_b64, 'base64'));
  const truncated = { ...env, ciphertext_b64: Buffer.from(ct.subarray(0, ct.length - 5)).toString('base64') };
  assert.throws(() => openEnvelope(key, truncated, 'item-abc', 3));
});

test('tampered metadata is rejected (flipped byte in ciphertext)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const env = sealEnvelope(key, ITEM);
  const ct = new Uint8Array(Buffer.from(env.ciphertext_b64, 'base64'));
  ct[0] ^= 1; // flips a byte inside the authenticated region (title bytes)
  const tampered = { ...env, ciphertext_b64: Buffer.from(ct).toString('base64') };
  assert.throws(() => openEnvelope(key, tampered, 'item-abc', 3));
});

test('tampered envelope metadata is rejected (unknown version, short nonce)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const env = sealEnvelope(key, ITEM);
  assert.throws(() => openEnvelope(key, { ...env, version: 2 }, 'item-abc', 3), /version/);
  assert.throws(
    () => openEnvelope(key, { ...env, nonce_b64: Buffer.from(new Uint8Array(12)).toString('base64') }, 'item-abc', 3),
    /nonce/,
  );
  assert.throws(() => openEnvelope(key, { ...env, ciphertext_b64: '!!!not-base64!!!' }, 'item-abc', 3));
});

test('wrong key is rejected', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const env = sealEnvelope(key, ITEM);
  const wrongKey = sodium.randombytes_buf(32);
  assert.throws(() => openEnvelope(wrongKey, env, 'item-abc', 3));
});

test('wrong passphrase KEK is rejected', async () => {
  const salt = sodium.randombytes_buf(16);
  const goodKek = await kek('correct horse battery staple', salt);
  const badKek = await kek('wrong passphrase', salt);
  const env = sealEnvelope(goodKek, ITEM);
  assert.throws(() => openEnvelope(badKek, env, 'item-abc', 3));
});

test('corrupted backup is rejected (one flipped byte in the joined blob)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  // Backup layout per specs/encryption-format.md: nonce (24B) || ciphertext+tag.
  const nonce = sodium.randombytes_buf(24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    enc.encode(JSON.stringify(ITEM)), null, null, nonce, key,
  );
  const blob = new Uint8Array(24 + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, 24);
  const corrupted = blob.slice();
  corrupted[corrupted.length - 1] ^= 0xff; // last tag byte
  const sealed = corrupted.subarray(24);
  assert.throws(
    () => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, null, corrupted.subarray(0, 24), key),
  );
  // Corrupted backup wrapper (invalid base64) is rejected before decrypt.
  assert.throws(() => openEnvelope(key, { version: 1, nonce_b64: '%%%bad%%%', ciphertext_b64: '%%%bad%%%' }, 'item-abc', 3));
  // Truncated backup (blob shorter than nonce + tag) is rejected.
  const short = blob.subarray(0, 30);
  assert.throws(
    () => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, short.subarray(24), null, short.subarray(0, 24), key),
  );
});

test('replay attempt is rejected (old revision presented as current)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  // The row is at revision 4; an attacker replays the sealed revision-3
  // payload. AEAD alone would accept it (it is a genuine seal), so the
  // plaintext revision binding must reject it.
  const oldEnv = sealEnvelope(key, { ...ITEM, revision: 3 });
  assert.throws(() => openEnvelope(key, oldEnv, 'item-abc', 4), /revision/);
});

test('modified encrypted payload is rejected (swapped ciphertext between items)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const envA = sealEnvelope(key, { ...ITEM, item_id: 'item-aaa' });
  // The ciphertext of item-aaa is stored under item-bbb's row. AEAD
  // passes (same key), so the inner item_id binding must reject it.
  assert.throws(() => openEnvelope(key, envA, 'item-bbb', 3), /item_id/);
});

test('valid envelope still opens (control: the guards reject, not everything)', async () => {
  await ready();
  const key = sodium.randombytes_buf(32);
  const env = sealEnvelope(key, ITEM);
  const obj = openEnvelope(key, env, 'item-abc', 3);
  assert.equal(obj.secret, 's3cret-value');
});
