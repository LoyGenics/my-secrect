// Production adapter known-answer and round-trip tests.
//
// Imports libsodiumAdapter from packages/crypto-adapters/src/index.ts.
// This is the gap left by tests/crypto-vectors/argon2id-vectors.test.mjs
// and tests/security/reject-tampering-libsodium.test.mjs, which call
// libsodium-wrappers-sumo directly and never load the adapter.
//
// Kept OUTSIDE tests/crypto-vectors/ and tests/security/ because those
// directories are run by CI with plain `node --test` (Node 20, no TS
// loader). Loading this TypeScript module needs Node's type stripper.
//
// Requires the package dependency libsodium-wrappers-sumo (see
// packages/crypto-adapters/package.json) to be installed so Node can
// resolve it from this file. No new dependency is added.
//
// Command (from the repo root):
//   node --experimental-strip-types --test --test-concurrency=1 \
//     packages/crypto-adapters/tests/libsodium-adapter.import.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARGON2ID_PARAMS,
  libsodiumAdapter,
  sodiumReady,
} from '../src/index.ts';

// Root `npm run test:real` lists only this file from this package, and
// the root package.json belongs to another workstream. This import
// registers the reference-adapter guard tests in this same run. When the
// root script lists the file itself, delete the line (otherwise the
// tests just run twice).
import './reference-adapter-guard.test.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const vectors = JSON.parse(readFileSync(
  path.join(repoRoot, 'tests/crypto-vectors/argon2id-vectors.json'),
  'utf8',
));

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

test.before(async () => {
  await sodiumReady;
});

test('imports the production libsodiumAdapter', () => {
  const resolved = import.meta.resolve('../src/index.ts');
  assert.match(resolved, /\/packages\/crypto-adapters\/src\/index\.ts$/);
  assert.equal(typeof libsodiumAdapter.deriveKek, 'function');
  assert.equal(typeof libsodiumAdapter.encrypt, 'function');
  assert.equal(typeof libsodiumAdapter.decrypt, 'function');
  assert.equal(typeof libsodiumAdapter.wrapKey, 'function');
  assert.equal(typeof libsodiumAdapter.unwrapKey, 'function');
  // v1 callers do not pass additional data. A required AD argument would
  // change the production arity (key, plaintext) and (key, nonce, ciphertext).
  assert.equal(libsodiumAdapter.encrypt.length, 2);
  assert.equal(libsodiumAdapter.decrypt.length, 3);
});

test('frozen Argon2id parameters stay at libsodium INTERACTIVE', () => {
  assert.equal(ARGON2ID_PARAMS.algorithm, 'argon2id');
  assert.equal(ARGON2ID_PARAMS.opslimit, 2);
  assert.equal(ARGON2ID_PARAMS.memlimit, 67108864);
  assert.equal(ARGON2ID_PARAMS.saltBytes, 16);
  assert.equal(ARGON2ID_PARAMS.outputBytes, 32);
  assert.equal(vectors.argon2id.opslimit, 2);
  assert.equal(vectors.argon2id.memlimit, 67108864);
  assert.equal(vectors.argon2id.salt_bytes, 16);
  assert.equal(vectors.argon2id.output_bytes, 32);
  assert.equal(ARGON2ID_PARAMS.opslimit, vectors.argon2id.opslimit);
  assert.equal(ARGON2ID_PARAMS.memlimit, vectors.argon2id.memlimit);
  assert.equal(vectors.xchacha20poly1305_ietf.key_bytes, 32);
  assert.equal(vectors.xchacha20poly1305_ietf.nonce_bytes, 24);
});

for (const vector of vectors.argon2id.vectors) {
  test(`deriveKek matches argon2id vector ${vector.id}`, { timeout: 120_000 }, async () => {
    const salt = hexToBytes(vector.salt_hex);
    assert.equal(salt.length, ARGON2ID_PARAMS.saltBytes);
    const kek = await libsodiumAdapter.deriveKek(vector.passphrase, salt);
    assert.equal(kek.length, ARGON2ID_PARAMS.outputBytes);
    assert.equal(toHex(kek), vector.kek_hex);
  });
}

test('decrypt opens the shared null-AD ciphertext without caller-supplied AD', async () => {
  // argon2id-vectors.json seals this vector with additional data null.
  // adapter.decrypt has no AD argument; success means the adapter passes null.
  const vector = vectors.xchacha20poly1305_ietf.vectors[0];
  const key = hexToBytes(vector.key_hex);
  const nonce = hexToBytes(vector.nonce_hex);
  const ciphertext = hexToBytes(vector.ciphertext_hex);
  assert.equal(key.length, 32);
  assert.equal(nonce.length, 24);
  const plaintext = await libsodiumAdapter.decrypt(key, nonce, ciphertext);
  assert.equal(new TextDecoder().decode(plaintext), vector.plaintext);
});

test('encrypt then decrypt round-trips with null additional data', async () => {
  const key = libsodiumAdapter.randomBytes(32);
  const plaintext = new TextEncoder().encode('vault item json');
  const sealed = await libsodiumAdapter.encrypt(key, plaintext);
  assert.equal(sealed.nonce.length, 24);
  assert.equal(sealed.ciphertext.length, plaintext.length + 16);
  const opened = await libsodiumAdapter.decrypt(key, sealed.nonce, sealed.ciphertext);
  assert.equal(toHex(opened), toHex(plaintext));
});

test('wrong key fails', async () => {
  const key = libsodiumAdapter.randomBytes(32);
  const wrongKey = new Uint8Array(key);
  wrongKey[0] ^= 0xff;
  const plaintext = new TextEncoder().encode('secret');
  const { nonce, ciphertext } = await libsodiumAdapter.encrypt(key, plaintext);
  await assert.rejects(() => libsodiumAdapter.decrypt(wrongKey, nonce, ciphertext));
});

test('truncated ciphertext fails', async () => {
  const key = libsodiumAdapter.randomBytes(32);
  const plaintext = new TextEncoder().encode('secret');
  const { nonce, ciphertext } = await libsodiumAdapter.encrypt(key, plaintext);
  const truncated = ciphertext.subarray(0, ciphertext.length - 1);
  assert.equal(truncated.length, ciphertext.length - 1);
  await assert.rejects(() => libsodiumAdapter.decrypt(key, nonce, truncated));
});

test('wrapKey and unwrapKey round-trip a 32-byte key', async () => {
  const wrappingKey = libsodiumAdapter.randomBytes(32);
  const keyToWrap = libsodiumAdapter.randomBytes(32);
  assert.equal(keyToWrap.length, 32);
  const { nonce, wrapped } = await libsodiumAdapter.wrapKey(wrappingKey, keyToWrap);
  assert.equal(nonce.length, 24);
  assert.equal(wrapped.length, keyToWrap.length + 16);
  const unwrapped = await libsodiumAdapter.unwrapKey(wrappingKey, nonce, wrapped);
  assert.equal(unwrapped.length, 32);
  assert.equal(toHex(unwrapped), toHex(keyToWrap));
});
