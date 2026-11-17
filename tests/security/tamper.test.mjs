// MIRROR: re-implements logic in-file; NOT production verification (see tests run via tsx --test for real-module coverage).
// Security hardening tests — ciphertext / metadata tampering.
//
// HONEST HEADER — READ BEFORE CITING THESE TESTS:
//   * MIRROR, not import. These tests re-implement AES-GCM + PBKDF2 with
//     Node WebCrypto in-file, exactly like tests/crypto-vectors/.
//     They do NOT import packages/crypto-adapters, native/crypto-core, or
//     any production vault code. A green run proves the AEAD RULES below;
//     it cannot prove the production libsodium path behaves the same.
//     The audited path is native/crypto-core (`cargo test`); the TS
//     libsodium adapters have no known-answer vectors yet (Phase A, gate 2).
//   * Plain Node 20+, no server, no TS loader: `node --test tests/security/`
//   * These tests NEVER ran on the Mac. Nothing here is verified.
//
// What is covered: invalid ciphertext, tampered nonce/tag/metadata,
// wrong key, truncated ciphertext, tampered associated data (AAD),
// nonce uniqueness (reuse is undetectable by AEAD — see test note).
import test from 'node:test';
import assert from 'node:assert/strict';

const enc = new TextEncoder();

async function importKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
// Mirror of the reference adapter: AES-256-GCM, 96-bit random nonce,
// AAD binds the ciphertext to its vault + item id (domain separation).
async function encrypt(key, plaintext, aad) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    await importKey(key), plaintext);
  return { nonce, ciphertext: new Uint8Array(ct) };
}
async function decrypt(key, nonce, ciphertext, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    await importKey(key), ciphertext);
  return new Uint8Array(pt);
}
function aadFor(vaultId, itemId) { return enc.encode(`my-secrect/v1/${vaultId}/${itemId}`); }

test('invalid ciphertext (random bytes) is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const garbage = crypto.getRandomValues(new Uint8Array(48));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  await assert.rejects(() => decrypt(key, nonce, garbage, aadFor('v1', 'i1')));
});

test('tampered ciphertext byte is rejected (AEAD tag check)', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('my password'), aadFor('v1', 'i1'));
  const tampered = Uint8Array.from(ciphertext);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  await assert.rejects(() => decrypt(key, nonce, tampered, aadFor('v1', 'i1')));
});

test('tampered tag (last 16 bytes) is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('secret'), aadFor('v1', 'i1'));
  const tampered = Uint8Array.from(ciphertext);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(() => decrypt(key, nonce, tampered, aadFor('v1', 'i1')));
});

test('tampered nonce is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('secret'), aadFor('v1', 'i1'));
  const badNonce = Uint8Array.from(nonce);
  badNonce[0] ^= 1;
  await assert.rejects(() => decrypt(key, badNonce, ciphertext, aadFor('v1', 'i1')));
});

test('truncated ciphertext is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('secret value'), aadFor('v1', 'i1'));
  await assert.rejects(() => decrypt(key, nonce, ciphertext.slice(0, ciphertext.length - 5), aadFor('v1', 'i1')));
  await assert.rejects(() => decrypt(key, nonce, new Uint8Array(0), aadFor('v1', 'i1')));
});

test('wrong key is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('secret'), aadFor('v1', 'i1'));
  await assert.rejects(() => decrypt(crypto.getRandomValues(new Uint8Array(32)), nonce, ciphertext, aadFor('v1', 'i1')));
});

test('tampered metadata: ciphertext moved to a different item id (AAD) is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('secret'), aadFor('vault_1', 'item_A'));
  // Attacker re-labels the row as item_B (or another vault) without the key.
  await assert.rejects(() => decrypt(key, nonce, ciphertext, aadFor('vault_1', 'item_B')));
  await assert.rejects(() => decrypt(key, nonce, ciphertext, aadFor('vault_2', 'item_A')));
  // And the honest path still works.
  assert.deepEqual(await decrypt(key, nonce, ciphertext, aadFor('vault_1', 'item_A')), enc.encode('secret'));
});

test('tampered metadata: shortened / empty AAD is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, enc.encode('secret'), aadFor('v1', 'i1'));
  await assert.rejects(() => decrypt(key, nonce, ciphertext, enc.encode('my-secrect/v1/v1')));
  await assert.rejects(() => decrypt(key, nonce, ciphertext, new Uint8Array(0)));
});

test('nonces are random and unique across many encryptions', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const { nonce } = await encrypt(key, enc.encode(`item ${i}`), aadFor('v1', `i${i}`));
    const hex = Buffer.from(nonce).toString('hex');
    assert.ok(!seen.has(hex), `nonce reused at iteration ${i}`);
    seen.add(hex);
  }
  // NOTE: AEAD cannot DETECT nonce reuse — reusing a nonce with the same
  // key silently destroys confidentiality. Uniqueness is a property of the
  // generator (crypto.getRandomValues), not of decrypt(). Production code
  // must never persist-and-replay a nonce; no test of decrypt() can check
  // that. This test only guards the generator used by THIS mirror.
});

test('empty plaintext encrypts and decrypts (no silent empty-ciphertext acceptance)', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, new Uint8Array(0), aadFor('v1', 'i1'));
  // AES-GCM of empty plaintext is just the 16-byte tag.
  assert.equal(ciphertext.length, 16);
  assert.deepEqual(await decrypt(key, nonce, ciphertext, aadFor('v1', 'i1')), new Uint8Array(0));
});
