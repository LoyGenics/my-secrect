/**
 * Crypto interface — ONE boundary for all crypto.
 *
 * MAIN implementation: libsodium (`libsodium-wrappers-sumo`), using
 * Argon2id for password-based key derivation and XChaCha20-Poly1305
 * (IETF variant) for authenticated encryption. This is the implementation
 * the vault core uses. It is NOT an audit: no part of this codebase is
 * claimed audited or production-ready.
 *
 * The old WebCrypto (AES-GCM + PBKDF2) reference adapter no longer lives
 * here: it moved to tests/reference/webcrypto-reference-adapter.ts so no
 * production bundle can import or select it (Metro does not tree-shake,
 * so exporting it from here shipped it in the mobile bundle).
 *
 * Dependency note: `libsodium-wrappers-sumo` must be listed as a
 * dependency of this package (package.json) — this file only imports it.
 * Callers must `await sodiumReady` (or just call the async methods, which
 * await `sodium.ready` internally) before the first operation.
 */
import sodium from 'libsodium-wrappers-sumo';

export interface CryptoAdapter {
  randomBytes(n: number): Uint8Array;
  deriveKek(passphrase: string, salt: Uint8Array): Promise<Uint8Array>; // Argon2id
  hkdf(ikm: Uint8Array, info: string, length?: number): Promise<Uint8Array>;
  encrypt(key: Uint8Array, plaintext: Uint8Array): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;
  decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
  wrapKey(wrappingKey: Uint8Array, keyToWrap: Uint8Array): Promise<{ nonce: Uint8Array; wrapped: Uint8Array }>;
  unwrapKey(wrappingKey: Uint8Array, nonce: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array>;
}

/** Resolves once libsodium's WASM module is initialised. */
export const sodiumReady: Promise<void> = sodium.ready;

/**
 * Locked Argon2id parameters (see specs/encryption-format.md and
 * specs/key-management.md). THE single profile for the whole vault:
 * libsodium's INTERACTIVE limits: OPSLIMIT_INTERACTIVE = 2,
 * MEMLIMIT_INTERACTIVE = 67108864 bytes (64 MiB), algorithm
 * crypto_pwhash_ALG_ARGON2ID13, salt 16 bytes, output 32 bytes.
 * The Rust crypto-core (native/crypto-core/src/lib.rs, KDF_OPSLIMIT /
 * KDF_MEMLIMIT) uses exactly these values. Cross-platform
 * known-answer vectors: tests/crypto-vectors/argon2id-vectors.json,
 * asserted by native/crypto-core/tests/vectors.rs and
 * tests/crypto-vectors/argon2id-vectors.test.mjs. Never change these
 * values without bumping the format version and regenerating vectors.
 */
export const ARGON2ID_PARAMS = {
  algorithm: 'argon2id',
  opslimit: 2,
  memlimit: 67108864,
  saltBytes: 16,
  outputBytes: 32,
  version: '1.0',
} as const;

/**
 * Browser-safe base64 (btoa/atob). The previous implementation used
 * Node-only `Buffer.from`, which throws `ReferenceError: Buffer is not
 * defined` in browsers, extension pages, and MV3 service workers — i.e.
 * in every client that actually uses this adapter. btoa/atob exist in
 * browsers, extension pages, workers, and Node 16+.
 */
export function toBase64(b: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    binary += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
export function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/** SHA-256 of `data` via libsodium (`crypto_hash_sha256`). Used by the vault for the recovery-key KEK. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_hash_sha256(data);
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error(`key must be ${sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES} bytes`);
  }
}

/**
 * HKDF-SHA-256 (RFC 5869), implemented with libsodium's HMAC-SHA-256
 * (`crypto_auth_hmacsha256`).
 *
 * Why not `crypto_kdf_derive_from_key`? That function is BLAKE2b-based,
 * derives a fixed-shape subkey from a master key + 8-byte context string,
 * and is NOT HKDF — it cannot take an arbitrary `info` string or an
 * arbitrary output length, and its output would not match HKDF test
 * vectors. HKDF here is therefore built directly from HMAC:
 *
 *   Extract: PRK = HMAC-SHA-256(salt, IKM), salt = 32 zero bytes when the
 *            caller supplies none (RFC 5869: salt defaults to HashLen
 *            zeros). HMAC keys here are always 32 bytes, which is
 *            `crypto_auth_hmacsha256_KEYBYTES`.
 *   Expand:  T(1) = HMAC(PRK, info || 0x01)
 *            T(i) = HMAC(PRK, T(i-1) || info || i), i = 2, 3, ...
 *            OKM = first `length` bytes of T(1) || T(2) || ...
 *
 * `length` must be 1..255 * 32 (HashLen = 32 for SHA-256).
 */
async function hkdfSha256(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  await sodium.ready;
  if (length < 1 || length > 255 * sodium.crypto_auth_hmacsha256_BYTES) {
    throw new Error('hkdf length must be between 1 and 8160 bytes');
  }
  const infoBytes = new TextEncoder().encode(info);
  const zeroSalt = new Uint8Array(sodium.crypto_auth_hmacsha256_KEYBYTES); // 32 zero bytes
  const prk = sodium.crypto_auth_hmacsha256(ikm, zeroSalt);
  const blocks: Uint8Array[] = [];
  let previous = new Uint8Array(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    const input = new Uint8Array(previous.length + infoBytes.length + 1);
    input.set(previous, 0);
    input.set(infoBytes, previous.length);
    input[input.length - 1] = counter;
    const block = sodium.crypto_auth_hmacsha256(input, prk);
    blocks.push(block);
    previous = block;
    produced += block.length;
    counter += 1;
  }
  const okm = new Uint8Array(length);
  let offset = 0;
  for (const block of blocks) {
    const take = Math.min(block.length, length - offset);
    okm.set(block.subarray(0, take), offset);
    offset += take;
  }
  return okm;
}

/**
 * MAIN adapter — libsodium (Argon2id + XChaCha20-Poly1305).
 *
 * - deriveKek: `crypto_pwhash` with OPSLIMIT_INTERACTIVE (2),
 *   MEMLIMIT_INTERACTIVE (67108864), ALG_ARGON2ID13, 32-byte output.
 * - encrypt: fresh 24-byte random nonce per call
 *   (`crypto_aead_xchacha20poly1305_ietf_NPUBBYTES` = 24), never reused
 *   under the same key (each item has its own random key, and the nonce
 *   is freshly sampled per encryption). Ciphertext returned by libsodium
 *   already includes the 16-byte Poly1305 tag appended to the ciphertext.
 * - decrypt: `crypto_aead_xchacha20poly1305_ietf_decrypt`; throws on any
 *   tampering (authentication failure) — callers must treat a throw as
 *   "reject this ciphertext".
 * - wrapKey/unwrapKey: the same AEAD encrypt/decrypt applied to key bytes.
 */
export const libsodiumAdapter: CryptoAdapter = {
  randomBytes(n: number): Uint8Array {
    // Synchronous by interface. Callers must have awaited `sodiumReady`
    // (or an async adapter method) once before the first call.
    return sodium.randombytes_buf(n);
  },
  async deriveKek(passphrase, salt) {
    await sodium.ready;
    if (salt.length !== ARGON2ID_PARAMS.saltBytes) {
      throw new Error(`salt must be ${ARGON2ID_PARAMS.saltBytes} bytes`);
    }
    return sodium.crypto_pwhash(
      ARGON2ID_PARAMS.outputBytes,
      new TextEncoder().encode(passphrase),
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  },
  async hkdf(ikm, info, length = 32) {
    return hkdfSha256(ikm, info, length);
  },
  async encrypt(key, plaintext) {
    await sodium.ready;
    assertKeyLength(key);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext, null, null, nonce, key,
    );
    return { nonce, ciphertext };
  },
  async decrypt(key, nonce, ciphertext) {
    await sodium.ready;
    assertKeyLength(key);
    if (nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) {
      throw new Error('nonce must be 24 bytes');
    }
    // NOTE: decrypt argument order is (secretNonce, ciphertext,
    // additionalData, publicNonce, key) — different from encrypt.
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, ciphertext, null, nonce, key,
    );
  },
  async wrapKey(wrappingKey, keyToWrap) {
    const { nonce, ciphertext } = await this.encrypt(wrappingKey, keyToWrap);
    return { nonce, wrapped: ciphertext };
  },
  async unwrapKey(wrappingKey, nonce, wrapped) {
    return this.decrypt(wrappingKey, nonce, wrapped);
  },
};
