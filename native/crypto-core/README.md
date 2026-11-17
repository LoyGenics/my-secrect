# crypto-core (audited boundary — NOT audited yet)

Small library, stable API, independently testable. Rust implementation of
the same formats the TypeScript apps use through `packages/crypto-adapters`
(libsodium-wrappers-sumo). Both sides must stay byte-compatible; that is
tested, see below. No production caller links this crate yet.

## Primitives (libsodium via `sodiumoxide` 0.2.7, HKDF via `hkdf`/`sha2`)
- KDF: `crypto_pwhash_argon2id` (Argon2id v1.3) with libsodium INTERACTIVE
  limits — opslimit 2, memlimit 64 MiB, 16-byte salt, 32-byte output
  (`KDF_OPSLIMIT` / `KDF_MEMLIMIT` / `KDF_SALT_BYTES`). Pinned by `const`
  asserts. Note: `sodiumoxide::crypto::pwhash` on its own is **scrypt**; the
  crate uses `pwhash::argon2id13`.
- Item AEAD and key wrap: XChaCha20-Poly1305 IETF, `nonce(24) || ciphertext+tag`.
  v1 = no additional data (default). v2 = AD-bound item primitives
  (`item_ad_v2`, `encrypt_item_v2`, `wrap_item_key_v2`, ...), not used by default.
- Recovery KEK: `recovery_kek` = SHA-256 (`crypto_hash_sha256`) of the 32-byte recovery key.
- File streaming: libsodium `secretstream` (`EncryptStream` / `DecryptStream`).
  Not the chunk format of `packages/storage`.
- Subkeys: HKDF-SHA-256 (`hkdf_sha256`).
- Randomness: libsodium CSPRNG.

Formats, versions and the v1 → v2 migration plan: `specs/encryption-format.md`.
Key hierarchy: `specs/key-management.md`.

## Run
```bash
cd native/crypto-core
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cargo run --example gen_chain_vectors   # rewrites the Rust-side fixtures in tests/crypto-vectors/
```
Requires a Rust toolchain; sodiumoxide builds/bundles libsodium.

## Tests
- `tests/vectors.rs`: Argon2id and XChaCha20-Poly1305 known answers from
  `tests/crypto-vectors/argon2id-vectors.json` (computed with libsodium via PyNaCl,
  re-checked with OpenSSL on the TS side).
- `tests/cross_impl.rs`: opens `chain-ts.json`, written by the real desktop,
  extension and mobile vault code, layer by layer (KEK → AMK → Vault Key →
  Item Key → item JSON, plus the recovery path); v2 and HKDF known answers.
  The TS side restores the Rust-written `chain-rust.json` through the real
  apps (`packages/crypto-adapters/tests/cross-impl.test.ts`).

## Honest status
- **No external security audit has been performed. Do not claim otherwise.**
- WASM bindings for the browser / extension are a LATER step, not done here.
