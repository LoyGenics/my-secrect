// ---------------------------------------------------------------------------
// REFERENCE ONLY — WebCrypto adapter (AES-GCM + PBKDF2). TEST-ONLY PATH.
//
// WARNING: This adapter is NOT production crypto for this vault. It uses
// AES-GCM with 12-byte nonces (not XChaCha20-Poly1305 with 24-byte
// nonces) and PBKDF2-SHA-256 with 600,000 iterations (not Argon2id), so
// nothing it writes can be read by libsodiumAdapter or native/crypto-core
// and vice versa. Do NOT use it for real user data.
//
// It used to be exported from packages/crypto-adapters/src/index.ts next
// to libsodiumAdapter. It was moved here (tests/, outside every app's
// import graph and outside the package's `src`) so that no production
// bundle can select it: Vite/Rollup tree-shook it, but Metro (mobile)
// does not tree-shake and shipped it. The guard test
// packages/crypto-adapters/tests/reference-adapter-guard.test.ts fails if
// any app or package source imports this file or if src/index.ts
// re-exports it. Kept only as a readable reference for the
// CryptoAdapter interface.
// ---------------------------------------------------------------------------
import type { CryptoAdapter } from '../../src/index';

async function importAesKey(key: Uint8Array) {
  return crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export const webCryptoReferenceAdapter: CryptoAdapter = {
  randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; },
  async deriveKek(passphrase, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 600_000, hash: 'SHA-256' }, base, 256);
    return new Uint8Array(bits);
  },
  async hkdf(ikm, info, length = 32) {
    const base = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(info) }, base, length * 8);
    return new Uint8Array(bits);
  },
  async encrypt(key, plaintext) {
    const nonce = this.randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, await importAesKey(key), plaintext as BufferSource);
    return { nonce, ciphertext: new Uint8Array(ct) };
  },
  async decrypt(key, nonce, ciphertext) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, await importAesKey(key), ciphertext as BufferSource);
    return new Uint8Array(pt);
  },
  async wrapKey(wrappingKey, keyToWrap) {
    const { nonce, ciphertext } = await this.encrypt(wrappingKey, keyToWrap);
    return { nonce, wrapped: ciphertext };
  },
  async unwrapKey(wrappingKey, nonce, wrapped) { return this.decrypt(wrappingKey, nonce, wrapped); },
};
