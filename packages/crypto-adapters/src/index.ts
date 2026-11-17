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
 * Item encryption versions (specs/encryption-format.md):
 *  - v1 (DEFAULT writer): XChaCha20-Poly1305 IETF, AD = null.
 *  - v2 (primitives only, no app writes it yet): same AEAD, AD binds the
 *    ciphertext to (purpose, vault_id, item_id, revision). See the
 *    "Item encryption v2" section below.
 *
 * Dependency note: `libsodium-wrappers-sumo` must be listed as a
 * dependency of this package (package.json) — this file only imports it.
 * Callers must `await sodiumReady` (or just call the async methods, which
 * await `sodiumReady` internally, which includes a self-test) before the first operation.
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

// BLAKE2b-256 of the input below, computed with libsodium and checked
// against Python's hashlib.blake2b(digest_size=32).
const SELF_TEST_INPUT = 'my-secrect/self-test/v1';
const SELF_TEST_BLAKE2B_HEX = '27f3f413ffd07bde022640dcc0a79e9781fb296df32c7f068ea5b6ad4fcfdd89';

/**
 * Fail closed when libsodium is not healthy. If WebAssembly is blocked (for
 * example a CSP without 'wasm-unsafe-eval'), libsodium-wrappers silently
 * falls back to asm.js; in the Tauri WKWebView that fallback returned stale
 * heap bytes from randombytes_buf, so "random" keys repeated earlier input.
 * Refuse to run rather than produce predictable keys.
 */
export function libsodiumSelfTest(): void {
  const kat = sodium.to_hex(sodium.crypto_generichash(32, sodium.from_string(SELF_TEST_INPUT)));
  if (kat !== SELF_TEST_BLAKE2B_HEX) throw new Error('libsodium self-test failed: BLAKE2b known answer mismatch');
  const seen = new Set<string>([kat]);
  for (let i = 0; i < 4; i++) {
    const r = sodium.randombytes_buf(32);
    if (r.every((b) => b === 0)) throw new Error('libsodium self-test failed: random bytes are all zero');
    const hex = sodium.to_hex(r);
    if (seen.has(hex)) throw new Error('libsodium self-test failed: random bytes repeated');
    seen.add(hex);
  }
}

/** Resolves once libsodium is initialised and has passed the self-test. */
export const sodiumReady: Promise<void> = sodium.ready.then(libsodiumSelfTest);

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
  await sodiumReady;
  return sodium.crypto_hash_sha256(data);
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error(`key must be ${sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES} bytes`);
  }
}

/**
 * The one XChaCha20-Poly1305 IETF seal every format uses. `ad` is null
 * for v1 and the v2 binding (itemAdV2) for v2. libsodium treats a null
 * AD and a zero-length AD identically (adlen 0), so a v1 ciphertext can
 * never verify under a v2 AD, which is always non-empty.
 */
async function sealXChaCha(
  key: Uint8Array,
  plaintext: Uint8Array,
  ad: Uint8Array | null,
): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  await sodiumReady;
  assertKeyLength(key);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, ad, null, nonce, key,
  );
  return { nonce, ciphertext };
}

async function openXChaCha(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  ad: Uint8Array | null,
): Promise<Uint8Array> {
  await sodiumReady;
  assertKeyLength(key);
  if (nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) {
    throw new Error('nonce must be 24 bytes');
  }
  // NOTE: decrypt argument order is (secretNonce, ciphertext,
  // additionalData, publicNonce, key) — different from encrypt.
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, ciphertext, ad, nonce, key,
  );
}

/** Every wrapped key in the hierarchy (AMK, Vault Key, Item Key, File Key) is 32 bytes. */
const WRAPPED_KEY_BYTES = 32;

/**
 * Unwrapped bytes that are not a 32-byte key are rejected, matching
 * native/crypto-core `unwrap_key` (which returns InvalidInput). Without
 * this the TS side would hand back a short or long "key" and only fail
 * later, at first use.
 */
function assertWrappedKeyLength(key: Uint8Array, what: string): void {
  if (key.length !== WRAPPED_KEY_BYTES) {
    throw new Error(`${what} must be ${WRAPPED_KEY_BYTES} bytes`);
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
  await sodiumReady;
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
 *   Both sides insist on 32-byte keys (same rule as native/crypto-core
 *   `wrap_key(&[u8; 32])` / `unwrap_key -> [u8; 32]`).
 */
export const libsodiumAdapter: CryptoAdapter = {
  randomBytes(n: number): Uint8Array {
    // Synchronous by interface. Callers must have awaited `sodiumReady`
    // (or an async adapter method) once before the first call.
    return sodium.randombytes_buf(n);
  },
  async deriveKek(passphrase, salt) {
    await sodiumReady;
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
    return sealXChaCha(key, plaintext, null);
  },
  async decrypt(key, nonce, ciphertext) {
    return openXChaCha(key, nonce, ciphertext, null);
  },
  async wrapKey(wrappingKey, keyToWrap) {
    assertWrappedKeyLength(keyToWrap, 'key to wrap');
    const { nonce, ciphertext } = await sealXChaCha(wrappingKey, keyToWrap, null);
    return { nonce, wrapped: ciphertext };
  },
  async unwrapKey(wrappingKey, nonce, wrapped) {
    const key = await openXChaCha(wrappingKey, nonce, wrapped, null);
    if (key.length !== WRAPPED_KEY_BYTES) key.fill(0);
    assertWrappedKeyLength(key, 'unwrapped key');
    return key;
  },
};

// ---------------------------------------------------------------------------
// Item encryption v2 — AEAD additional data binds each ciphertext to its slot.
//
// NOT THE DEFAULT. Every app still writes v1 (DEFAULT_ITEM_ENCRYPTION_VERSION).
// Switching a caller to v2 needs the coordinated rollout in
// specs/encryption-format.md ("v2 migration plan"): a stable vault_id in
// the key envelope, the sync revision known at encrypt time, backup and
// native storage readers that understand encryption_version 2.
//
// Why: v1 uses AD = null, so the AEAD tag says nothing about WHICH item,
// vault, revision or purpose a ciphertext belongs to. v1 relies on the
// decrypted JSON id check (callers) and on key separation; it cannot
// stop a malicious server or storage layer from relabelling an old
// ciphertext with a newer revision (rollback), and any Vault-Key
// ciphertext of a 32-byte plaintext the attacker knows (e.g. a device
// name of exactly 32 bytes) would unwrap as a valid "item key". v2 puts
// all of that under the tag.
//
// AD layout (all integers big-endian; no separators, every variable
// field is length-prefixed so the encoding is injective):
//
//   AD = u32(len(label))    || label            (ASCII, see ITEM_AD_V2_LABELS)
//     || u32(len(vault_id)) || vault_id         (UTF-8, 1..1024 bytes)
//     || u32(len(item_id))  || item_id          (UTF-8, 1..1024 bytes)
//     || u64(revision)                          (0..2^53-1)
//
// The label differs for the payload and for the wrapped item key, so a
// wrapped key never opens as a payload or the reverse, and neither opens
// as any v1 (null-AD) Vault-Key ciphertext. Byte layout on disk/wire is
// unchanged from v1 (nonce(24) || ciphertext+tag); the version lives in
// the existing `encryption_version` field. Relabelling a v2 row as v1
// fails closed (a v2 tag never verifies with null AD).
// Mirrored byte-for-byte by native/crypto-core `item_ad_v2`; shared
// vectors: tests/crypto-vectors/item-v2-vectors.json.
// ---------------------------------------------------------------------------

export const ITEM_ENCRYPTION_V1 = 1 as const;
export const ITEM_ENCRYPTION_V2 = 2 as const;
/** The version every writer uses today. Do not change without the migration plan. */
export const DEFAULT_ITEM_ENCRYPTION_VERSION = ITEM_ENCRYPTION_V1;

export const ITEM_AD_V2_LABELS = {
  payload: 'my-secrect/item-payload/v2',
  keyWrap: 'my-secrect/item-key-wrap/v2',
} as const;
export type ItemAdV2Purpose = keyof typeof ITEM_AD_V2_LABELS;

/** Where a v2 ciphertext belongs. Ids are compared byte-for-byte (no Unicode normalisation). */
export interface ItemBindingV2 {
  vaultId: string;
  itemId: string;
  revision: number;
}

/** Upper bound on vault_id / item_id, in UTF-8 bytes. Real ids are UUID-sized. */
export const ITEM_AD_V2_MAX_ID_BYTES = 1024;

/**
 * Reject lone UTF-16 surrogates. TextEncoder would silently turn them
 * into U+FFFD, so two different JS strings could produce the same AD
 * bytes; Rust `&str` cannot hold them at all. Hand-rolled (not
 * String#isWellFormed / TextDecoder) because Hermes on mobile lacks both
 * in some versions.
 */
function assertWellFormedUtf16(s: string, what: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${what} contains a lone surrogate`);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error(`${what} contains a lone surrogate`);
    }
  }
}

function boundIdBytes(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`);
  assertWellFormedUtf16(value, what);
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < 1 || bytes.length > ITEM_AD_V2_MAX_ID_BYTES) {
    throw new Error(`${what} must be 1..${ITEM_AD_V2_MAX_ID_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

/**
 * Build the v2 additional data for one item slot. Throws on an empty or
 * oversized id or a revision that is not a safe non-negative integer
 * (2^53-1 is the largest value both JS and the Rust side represent).
 */
export function itemAdV2(purpose: ItemAdV2Purpose, binding: ItemBindingV2): Uint8Array {
  const label = ITEM_AD_V2_LABELS[purpose];
  if (label === undefined) throw new Error('unknown item AD purpose');
  const labelBytes = new TextEncoder().encode(label);
  const vaultId = boundIdBytes(binding.vaultId, 'vault_id');
  const itemId = boundIdBytes(binding.itemId, 'item_id');
  const { revision } = binding;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('revision must be an integer in 0..2^53-1');
  }
  const parts = [labelBytes, vaultId, itemId];
  const ad = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0) + 8);
  const view = new DataView(ad.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    ad.set(part, offset + 4);
    offset += 4 + part.length;
  }
  // u64 big-endian from a safe integer: high 32 bits, then low 32 bits.
  view.setUint32(offset, Math.floor(revision / 4294967296), false);
  view.setUint32(offset + 4, revision % 4294967296, false);
  return ad;
}

/** v2 item payload encrypt: XChaCha20-Poly1305 under the Item Key, AD = itemAdV2('payload', binding). */
export async function encryptItemPayloadV2(
  itemKey: Uint8Array,
  plaintext: Uint8Array,
  binding: ItemBindingV2,
): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  return sealXChaCha(itemKey, plaintext, itemAdV2('payload', binding));
}

/** v2 item payload decrypt. Throws when the tag fails OR the binding differs from the writer's. */
export async function decryptItemPayloadV2(
  itemKey: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  binding: ItemBindingV2,
): Promise<Uint8Array> {
  return openXChaCha(itemKey, nonce, ciphertext, itemAdV2('payload', binding));
}

/** v2 Item Key wrap under the Vault Key, AD = itemAdV2('keyWrap', binding). */
export async function wrapItemKeyV2(
  vaultKey: Uint8Array,
  itemKey: Uint8Array,
  binding: ItemBindingV2,
): Promise<{ nonce: Uint8Array; wrapped: Uint8Array }> {
  assertWrappedKeyLength(itemKey, 'item key');
  const { nonce, ciphertext } = await sealXChaCha(vaultKey, itemKey, itemAdV2('keyWrap', binding));
  return { nonce, wrapped: ciphertext };
}

/** v2 Item Key unwrap. Throws on a bad tag, a binding mismatch, or a non-32-byte result. */
export async function unwrapItemKeyV2(
  vaultKey: Uint8Array,
  nonce: Uint8Array,
  wrapped: Uint8Array,
  binding: ItemBindingV2,
): Promise<Uint8Array> {
  const key = await openXChaCha(vaultKey, nonce, wrapped, itemAdV2('keyWrap', binding));
  if (key.length !== WRAPPED_KEY_BYTES) key.fill(0);
  assertWrappedKeyLength(key, 'unwrapped item key');
  return key;
}
