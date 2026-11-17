// Argon2id + XChaCha20-Poly1305 known-answer vectors — TypeScript side.
// Plain Node 20+, no server, no TS loader.
//
// HONESTY NOTE — read before trusting a green run:
// * This file CANNOT import the TypeScript adapter
//   (packages/crypto-adapters/src/index.ts) because `node --test` has no
//   TS loader. Instead it calls the SAME libsodium functions with the
//   SAME parameters the adapter uses (crypto_pwhash with
//   OPSLIMIT_INTERACTIVE / MEMLIMIT_INTERACTIVE / ALG_ARGON2ID13, and
//   crypto_aead_xchacha20poly1305_ietf_*), and compares against the
//   shared vectors in argon2id-vectors.json.
// * What this DOES prove: the locked parameters in this repo produce
//   the same bytes libsodium produces on the Rust side (the Rust test
//   asserts the identical vectors), i.e. TS/Rust KEK compatibility.
// * What it does NOT prove: that libsodiumAdapter.deriveKek itself is
//   correct. That is covered by tests that import the real adapter and
//   app code under tsx (root `npm run test:real`):
//   packages/crypto-adapters/tests/libsodium-adapter.import.test.mjs and
//   packages/crypto-adapters/tests/cross-impl.test.ts (TS <-> Rust
//   fixtures, OpenSSL re-derivation). The `parameters match the adapter
//   source` test below is only a guard against the constants drifting
//   apart, not a substitute.
// * Run after `npm install` (needs libsodium-wrappers-sumo from the
//   workspace). No network, no server, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sodium from 'libsodium-wrappers-sumo';

const dir = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(dir, 'argon2id-vectors.json'), 'utf8'));

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
}

for (const v of vectors.argon2id.vectors) {
  test(`argon2id KEK matches shared vector (${v.id})`, async () => {
    await sodium.ready;
    assert.equal(sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, vectors.argon2id.opslimit);
    assert.equal(sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE, vectors.argon2id.memlimit);
    const kek = sodium.crypto_pwhash(
      vectors.argon2id.output_bytes,
      new TextEncoder().encode(v.passphrase),
      hexToBytes(v.salt_hex),
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    assert.equal(Buffer.from(kek).toString('hex'), v.kek_hex);
  });
}

for (const v of vectors.xchacha20poly1305_ietf.vectors) {
  test(`xchacha20-poly1305 seal matches shared vector (${v.id})`, async () => {
    await sodium.ready;
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(v.plaintext),
      null,
      null,
      hexToBytes(v.nonce_hex),
      hexToBytes(v.key_hex),
    );
    assert.equal(Buffer.from(ct).toString('hex'), v.ciphertext_hex);
    const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      hexToBytes(v.ciphertext_hex),
      null,
      hexToBytes(v.nonce_hex),
      hexToBytes(v.key_hex),
    );
    assert.equal(new TextDecoder().decode(pt), v.plaintext);
  });
}

test('locked Argon2id parameters in the adapter source match the shared vectors', () => {
  // Drift guard only (see header): the adapter source must state the
  // same profile the vectors were generated with.
  const src = readFileSync(
    path.join(dir, '..', '..', 'packages', 'crypto-adapters', 'src', 'index.ts'),
    'utf8',
  );
  assert.match(src, /opslimit:\s*2/);
  assert.match(src, /memlimit:\s*67108864/);
  assert.match(src, /crypto_pwhash_ALG_ARGON2ID13/);
  assert.match(src, /OPSLIMIT_INTERACTIVE/);
  assert.match(src, /MEMLIMIT_INTERACTIVE/);
});
