/**
 * The `libsodium-wrappers-sumo` surface this repo uses, on top of a native
 * libsodium binding with react-native-libsodium's calling conventions.
 * Pure (no React Native import) so Node can test it with real libsodium.
 *
 * Why: Hermes has no WebAssembly, and libsodium-wrappers' asm.js fallback
 * is broken there (randombytes_buf returned stale heap bytes, AEAD did not
 * round-trip). Every operation below runs in native libsodium, except
 * SHA-256, which react-native-libsodium does not bind: it comes from
 * @noble/hashes (audited, also a dependency of react-native-libsodium).
 *
 * Covers every sodium.* call in packages/crypto-adapters, packages/sdk,
 * packages/core and apps/mobile, plus main's self-test (BLAKE2b KAT,
 * to_hex, from_string).
 */
type Bytes = Uint8Array;
type Message = Bytes | string;

/** What the shim needs from react-native-libsodium (named exports). */
export interface NativeSodium {
  ready: Promise<unknown>;
  randombytes_buf(length: number): Bytes;
  crypto_pwhash(keyLength: number, password: Message, salt: Bytes, opsLimit: number, memLimit: number, algorithm: number): Bytes;
  crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash_SALTBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_encrypt(message: Message, ad: string | null, nsec: null, npub: Bytes, key: Bytes): Bytes;
  crypto_aead_xchacha20poly1305_ietf_decrypt(nsec: null, ciphertext: Bytes, ad: string | null, npub: Bytes, key: Bytes): Bytes;
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  crypto_generichash(length: number, message: Message, key?: Bytes | null): Bytes;
  crypto_sign_seed_keypair(seed: Bytes): { publicKey: Bytes; privateKey: Bytes; keyType: string };
  crypto_sign_detached(message: Message, privateKey: Bytes): Bytes;
  /** HMAC-SHA256 with `salt` as the HMAC key over `key` (RFC 5869 HKDF-Extract). */
  _unstable_crypto_kdf_hkdf_sha256_extract(key: Bytes, salt: Bytes): Bytes;
  to_hex(input: Bytes): string;
}

/**
 * react-native-libsodium hands `x.buffer` to JSI, so a subarray view would
 * pass its whole parent buffer (vault.ts slices nonces and ciphertexts out
 * of one blob). Give native code an array that owns exactly its bytes.
 */
function own(x: Bytes): Bytes {
  return x.byteOffset === 0 && x.byteLength === x.buffer.byteLength ? x : x.slice();
}
function msg(x: Message): Message { return typeof x === 'string' ? x : own(x); }

/**
 * The native AEAD binding only takes additional data as a JS string, sent
 * as UTF-8. 7-bit bytes map 1:1, so they pass unchanged; any byte >= 0x80
 * cannot be represented, and the call fails instead of authenticating
 * different bytes. null and empty both mean adlen 0 in libsodium.
 */
function adString(ad: Bytes | string | null | undefined): string {
  if (ad == null) return '';
  if (typeof ad === 'string') return ad;
  let s = '';
  for (let i = 0; i < ad.length; i++) {
    if (ad[i] > 0x7f) throw new Error('libsodium (react-native): additional data with bytes >= 0x80 is not supported by the native binding');
    s += String.fromCharCode(ad[i]);
  }
  return s;
}

const utf8 = new TextEncoder();

export function createSodium(native: NativeSodium, sha256: (data: Bytes) => Bytes) {
  return {
    // Constants come from the JSI install; missing ones mean the native module is not in this build.
    ready: native.ready.then(() => {
      if (typeof native.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES !== 'number') {
        throw new Error('native libsodium is not installed in this build (react-native-libsodium)');
      }
    }),
    randombytes_buf: (length: number): Bytes => native.randombytes_buf(length),
    crypto_pwhash: (keyLength: number, password: Message, salt: Bytes, opsLimit: number, memLimit: number, algorithm: number): Bytes =>
      native.crypto_pwhash(keyLength, msg(password), own(salt), opsLimit, memLimit, algorithm),
    get crypto_pwhash_OPSLIMIT_INTERACTIVE() { return native.crypto_pwhash_OPSLIMIT_INTERACTIVE; },
    get crypto_pwhash_MEMLIMIT_INTERACTIVE() { return native.crypto_pwhash_MEMLIMIT_INTERACTIVE; },
    get crypto_pwhash_ALG_ARGON2ID13() { return native.crypto_pwhash_ALG_ARGON2ID13; },
    get crypto_pwhash_SALTBYTES() { return native.crypto_pwhash_SALTBYTES; },
    crypto_aead_xchacha20poly1305_ietf_encrypt: (message: Message, ad: Bytes | string | null, _nsec: null, npub: Bytes, key: Bytes): Bytes =>
      native.crypto_aead_xchacha20poly1305_ietf_encrypt(msg(message), adString(ad), null, own(npub), own(key)),
    crypto_aead_xchacha20poly1305_ietf_decrypt: (_nsec: null, ciphertext: Bytes, ad: Bytes | string | null, npub: Bytes, key: Bytes): Bytes =>
      native.crypto_aead_xchacha20poly1305_ietf_decrypt(null, own(ciphertext), adString(ad), own(npub), own(key)),
    get crypto_aead_xchacha20poly1305_ietf_NPUBBYTES() { return native.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES; },
    get crypto_aead_xchacha20poly1305_ietf_KEYBYTES() { return native.crypto_aead_xchacha20poly1305_ietf_KEYBYTES; },
    crypto_generichash: (length: number, message: Message, key?: Bytes | null): Bytes =>
      native.crypto_generichash(length, msg(message), key ? own(key) : undefined),
    crypto_sign_seed_keypair: (seed: Bytes) => native.crypto_sign_seed_keypair(own(seed)),
    crypto_sign_detached: (message: Message, privateKey: Bytes): Bytes => native.crypto_sign_detached(msg(message), own(privateKey)),
    // HMAC-SHA256(key, message) = HKDF-Extract(salt = key, ikm = message), computed by native libsodium.
    crypto_auth_hmacsha256: (message: Bytes, key: Bytes): Bytes =>
      native._unstable_crypto_kdf_hkdf_sha256_extract(own(message), own(key)),
    crypto_auth_hmacsha256_BYTES: 32, // libsodium crypto_auth_hmacsha256_BYTES
    crypto_auth_hmacsha256_KEYBYTES: 32, // libsodium crypto_auth_hmacsha256_KEYBYTES
    crypto_hash_sha256: (message: Bytes): Bytes => sha256(message),
    to_hex: (input: Bytes): string => native.to_hex(own(input)),
    from_string: (s: string): Bytes => utf8.encode(s),
  };
}

export type SodiumShim = ReturnType<typeof createSodium>;
