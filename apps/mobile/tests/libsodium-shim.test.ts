/**
 * Real-module test of src/crypto/libsodium-shim.ts. The native binding is
 * stood in by real libsodium (libsodium-wrappers-sumo, WASM in Node) under
 * react-native-libsodium's calling rules: it reads `x.buffer` of every
 * input and only accepts additional data as a string. packages/crypto-adapters
 * is loaded with 'libsodium-wrappers-sumo' resolved to the shim, exactly as
 * metro.config.js does on iOS/Android. The JSI binding itself only runs on
 * a simulator / emulator (apps/mobile/dev/CryptoCheck.tsx).
 * Run: npx tsx --test apps/mobile/tests/libsodium-shim.test.ts
 */
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { sha256 } from '@noble/hashes/sha256';
import { createSodium, type NativeSodium } from '../src/crypto/libsodium-shim';

const req = createRequire(import.meta.url);
const real = req('libsodium-wrappers-sumo') as Record<string, any>;
const vectors = req('../../../tests/crypto-vectors/argon2id-vectors.json') as {
  argon2id: { vectors: Array<{ id: string; passphrase: string; salt_hex: string; kek_hex: string }> };
  xchacha20poly1305_ietf: { vectors: Array<{ id: string; key_hex: string; nonce_hex: string; plaintext: string; ciphertext_hex: string }> };
};
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** What JSI receives: the whole ArrayBuffer behind the argument. */
const jsi = (x: Uint8Array) => new Uint8Array(x.buffer);
const adBytes = (ad: unknown) => {
  if (typeof ad !== 'string') throw new Error('additional_data must be a string');
  return new TextEncoder().encode(ad);
};
function standIn(): NativeSodium {
  return {
    ready: real.ready,
    randombytes_buf: (n) => real.randombytes_buf(n),
    crypto_pwhash: (len, pw, salt, ops, mem, alg) => real.crypto_pwhash(len, typeof pw === 'string' ? pw : jsi(pw), jsi(salt), ops, mem, alg),
    get crypto_pwhash_OPSLIMIT_INTERACTIVE() { return real.crypto_pwhash_OPSLIMIT_INTERACTIVE; },
    get crypto_pwhash_MEMLIMIT_INTERACTIVE() { return real.crypto_pwhash_MEMLIMIT_INTERACTIVE; },
    get crypto_pwhash_ALG_ARGON2ID13() { return real.crypto_pwhash_ALG_ARGON2ID13; },
    get crypto_pwhash_SALTBYTES() { return real.crypto_pwhash_SALTBYTES; },
    crypto_aead_xchacha20poly1305_ietf_encrypt: (m, ad, _n, npub, key) =>
      real.crypto_aead_xchacha20poly1305_ietf_encrypt(typeof m === 'string' ? m : jsi(m), adBytes(ad), null, jsi(npub), jsi(key)),
    crypto_aead_xchacha20poly1305_ietf_decrypt: (_n, c, ad, npub, key) =>
      real.crypto_aead_xchacha20poly1305_ietf_decrypt(null, jsi(c), adBytes(ad), jsi(npub), jsi(key)),
    get crypto_aead_xchacha20poly1305_ietf_NPUBBYTES() { return real.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES; },
    get crypto_aead_xchacha20poly1305_ietf_KEYBYTES() { return real.crypto_aead_xchacha20poly1305_ietf_KEYBYTES; },
    crypto_generichash: (len, m, key) => real.crypto_generichash(len, typeof m === 'string' ? m : jsi(m), key ? jsi(key) : null),
    crypto_sign_seed_keypair: (seed) => ({ ...real.crypto_sign_seed_keypair(jsi(seed)), keyType: 'ed25519' }),
    crypto_sign_detached: (m, sk) => real.crypto_sign_detached(typeof m === 'string' ? m : jsi(m), jsi(sk)),
    // libsodium crypto_kdf_hkdf_sha256_extract(prk, salt, ikm=key) = HMAC-SHA256(salt, key), any salt
    // length. libsodium-wrappers 0.7.15 does not export it (and its HMAC API wants a 32-byte key), so
    // the stand-in uses OpenSSL HMAC.
    _unstable_crypto_kdf_hkdf_sha256_extract: (key, salt) => Uint8Array.from(createHmac('sha256', jsi(salt)).update(jsi(key)).digest()),
    to_hex: (b) => real.to_hex(jsi(b)),
  };
}

const shim = createSodium(standIn(), sha256);
// Same substitution metro.config.js makes on iOS/Android.
const mod = req('node:module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = mod._load;
mod._load = function (request: string, ...rest: unknown[]) {
  if (request === 'libsodium-wrappers-sumo') return { __esModule: true, default: shim };
  return originalLoad.call(this, request, ...rest);
};

test('Argon2id vectors through crypto-adapters on the shim', { timeout: 120_000 }, async () => {
  const { libsodiumAdapter } = await import('../../../packages/crypto-adapters/src/index.ts');
  for (const v of vectors.argon2id.vectors) {
    assert.equal(toHex(await libsodiumAdapter.deriveKek(v.passphrase, hex(v.salt_hex))), v.kek_hex, v.id);
  }
});

test('XChaCha20-Poly1305 vectors: exact ciphertext, and decrypt from subarray views of one blob', async () => {
  const { libsodiumAdapter } = await import('../../../packages/crypto-adapters/src/index.ts');
  for (const v of vectors.xchacha20poly1305_ietf.vectors) {
    const ct = shim.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode(v.plaintext), null, null, hex(v.nonce_hex), hex(v.key_hex));
    assert.equal(toHex(ct), v.ciphertext_hex, v.id);
    const blob = hex(v.nonce_hex + v.ciphertext_hex); // vault.ts stores nonce||ct and slices views out of it
    const pt = await libsodiumAdapter.decrypt(hex(v.key_hex), blob.subarray(0, 24), blob.subarray(24));
    assert.equal(Buffer.from(pt).toString('utf8'), v.plaintext, v.id);
  }
});

test('HKDF-SHA256 (HMAC via native HKDF-Extract) matches OpenSSL, single and multi block', async () => {
  const { libsodiumAdapter } = await import('../../../packages/crypto-adapters/src/index.ts');
  const ikm = hex('0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a');
  for (const [info, len] of [['my-secrect/item-key/v1', 32], ['multi', 100], ['', 42]] as const) {
    const want = Buffer.from(hkdfSync('sha256', ikm, new Uint8Array(32), info, len)).toString('hex');
    assert.equal(toHex(await libsodiumAdapter.hkdf(ikm, info, len)), want, `${info}/${len}`);
  }
});

test('SHA-256, HMAC-SHA256, BLAKE2b and Ed25519 known answers', async () => {
  await shim.ready;
  assert.equal(toHex(shim.crypto_hash_sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // RFC 4231 test case 2
  assert.equal(toHex(shim.crypto_auth_hmacsha256(new TextEncoder().encode('what do ya want for nothing?'), new TextEncoder().encode('Jefe'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  // main's self-test KAT (packages/crypto-adapters libsodiumSelfTest)
  assert.equal(shim.to_hex(shim.crypto_generichash(32, shim.from_string('my-secrect/self-test/v1'))), '27f3f413ffd07bde022640dcc0a79e9781fb296df32c7f068ea5b6ad4fcfdd89');
  // RFC 8032 test 1 (empty message)
  const kp = shim.crypto_sign_seed_keypair(hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
  assert.equal(toHex(kp.publicKey), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(toHex(shim.crypto_sign_detached(new Uint8Array(0), kp.privateKey)),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
});

test('additional data: 7-bit bytes authenticate as bytes; >= 0x80 fails closed', async () => {
  await shim.ready;
  const key = hex('00'.repeat(32)); const nonce = hex('11'.repeat(24)); const m = new TextEncoder().encode('m');
  const ad = Uint8Array.from([0, 0, 0, 3, 0x61, 0x62, 0x63, 0x7f]);
  const ct = shim.crypto_aead_xchacha20poly1305_ietf_encrypt(m, ad, null, nonce, key);
  assert.equal(toHex(ct), toHex(real.crypto_aead_xchacha20poly1305_ietf_encrypt(m, ad, null, nonce, key)));
  assert.deepEqual(shim.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce, key), m);
  assert.throws(() => shim.crypto_aead_xchacha20poly1305_ietf_encrypt(m, Uint8Array.from([0x80]), null, nonce, key), /bytes >= 0x80/);
  assert.throws(() => shim.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, Uint8Array.from([0x61]), nonce, key));
});

test('random draws are 32 non-zero, distinct values (main self-test rule)', async () => {
  await shim.ready;
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = shim.randombytes_buf(32);
    assert.ok(r.some((b) => b !== 0));
    seen.add(toHex(r));
  }
  assert.equal(seen.size, 4);
});

test('ready rejects when the native binding is not installed', async () => {
  const broken = { ...standIn(), crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: undefined } as unknown as NativeSodium;
  await assert.rejects(() => createSodium(broken, sha256).ready, /not installed/);
});
