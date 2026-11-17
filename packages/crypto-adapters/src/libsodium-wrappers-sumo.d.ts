// Compile-time stand-in for the missing libsodium-wrappers-sumo@0.7 declaration.
// The published package points `types` at a file that is not in the tarball,
// and the ESM entry selected by moduleResolution "bundler" has no sibling .d.ts.
// Shared by every client package (extension, desktop, web, mobile, crypto-adapters).
// Only the members the code calls are listed. This does not
// verify that those calls match libsodium at runtime.

declare module 'libsodium-wrappers-sumo' {
  // Accept either backing-buffer spelling. Typed arrays are invariant, and
  // TS 5.7+ defaults Uint8Array to ArrayBufferLike while `new Uint8Array()`
  // is ArrayBuffer.
  type SodiumBytes = Uint8Array<ArrayBuffer> | Uint8Array<ArrayBufferLike>;
  // Assignable to both spellings, so call sites can store the result either way.
  type SodiumOut = Uint8Array<ArrayBuffer> & Uint8Array<ArrayBufferLike>;

  interface LibsodiumSumo {
    ready: Promise<void>;
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    crypto_auth_hmacsha256_BYTES: number;
    crypto_auth_hmacsha256_KEYBYTES: number;
    crypto_pwhash_ALG_ARGON2ID13: number;
    crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
    crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      secretNonce: SodiumBytes | null,
      ciphertext: SodiumBytes,
      additionalData: SodiumBytes | null,
      publicNonce: SodiumBytes,
      key: SodiumBytes,
    ): SodiumOut;
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      message: SodiumBytes,
      additionalData: SodiumBytes | null,
      secretNonce: SodiumBytes | null,
      publicNonce: SodiumBytes,
      key: SodiumBytes,
    ): SodiumOut;
    crypto_auth_hmacsha256(message: SodiumBytes, key: SodiumBytes): SodiumOut;
    crypto_hash_sha256(message: SodiumBytes): SodiumOut;
    crypto_pwhash(
      outputLength: number,
      password: SodiumBytes,
      salt: SodiumBytes,
      opsLimit: number,
      memLimit: number,
      algorithm: number,
    ): SodiumOut;
    randombytes_buf(length: number): SodiumOut;
    crypto_sign_seed_keypair(seed: SodiumBytes): {
      keyType: string;
      publicKey: SodiumOut;
      privateKey: SodiumOut;
    };
    crypto_sign_detached(message: SodiumBytes, privateKey: SodiumBytes): SodiumOut;
    crypto_generichash(hashLength: number, message: SodiumBytes, key?: SodiumBytes | null): SodiumOut;
    from_string(text: string): SodiumOut;
    to_hex(bytes: SodiumBytes): string;
  }

  const sodium: LibsodiumSumo;
  export default sodium;
}
