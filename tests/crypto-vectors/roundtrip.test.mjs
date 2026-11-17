// Crypto round-trip tests — plain Node 20+, no server, no TS loader.
// These test the WebCrypto REFERENCE adapter logic (AES-GCM + PBKDF2)
// inlined here, NOT the production libsodium crypto-core.
// The audited path is native/crypto-core (Rust + libsodium, `cargo test`).
// Do not present these as libsodium known-answer vectors.
import test from 'node:test';
import assert from 'node:assert/strict';

async function importKey(key) {
  return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encrypt(key, pt) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await importKey(key), pt);
  return { nonce, ciphertext: new Uint8Array(ct) };
}
async function decrypt(key, nonce, ct) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await importKey(key), ct);
  return new Uint8Array(pt);
}

test('encrypt/decrypt round-trip', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const pt = new TextEncoder().encode('hello vault');
  const { nonce, ciphertext } = await encrypt(key, pt);
  assert.deepEqual(await decrypt(key, nonce, ciphertext), pt);
});

test('tampered ciphertext is rejected (AEAD)', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, new TextEncoder().encode('secret'));
  ciphertext[0] ^= 1;
  await assert.rejects(() => decrypt(key, nonce, ciphertext));
});

test('wrong key is rejected', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(key, new TextEncoder().encode('secret'));
  await assert.rejects(() => decrypt(crypto.getRandomValues(new Uint8Array(32)), nonce, ciphertext));
});
