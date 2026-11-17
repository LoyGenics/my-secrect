# crypto-core (audited boundary)

Small library, stable API, independently testable. This is where the REAL
crypto lives — NOT in `packages/crypto-adapters` (which is a WebCrypto
reference for the desktop prototype).

## Primitives (libsodium via `sodiumoxide`, HKDF via `hkdf`/`sha2`)
- KDF: `crypto_pwhash` — Argon2id, SENSITIVE limits, versioned (`KDF_OPSLIMIT`/`KDF_MEMLIMIT`, format v1).
- Item AEAD: XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf`).
- File streaming: libsodium `secretstream` (XChaCha20-Poly1305, chunked, ordered, final tag).
- Subkeys: HKDF-SHA-256, purpose-bound `info` strings.
- Randomness: libsodium CSPRNG.

## API (`src/lib.rs`)
`init()`, `random_bytes()`, `derive_kek(passphrase, salt)`, `hkdf_sha256()`,
`encrypt_item()` / `decrypt_item()`, `wrap_key()` / `unwrap_key()`,
`EncryptStream` / `DecryptStream`.

## Run
```bash
cd native/crypto-core
cargo test
```
Requires a Rust toolchain + libsodium (sodiumoxide builds/bundles it;
see the crate docs if the system lib is missing).

## Honest status
- Unit tests in `src/lib.rs` + integration tests in `tests/vectors.rs`
  are round-trip / tamper-rejection tests, NOT external known-answer vectors.
- **No external security audit has been performed. Do not claim otherwise.**
- WASM bindings for the browser / extension are a LATER step, not done here.
- The TypeScript `packages/crypto-adapters` reference (AES-GCM/PBKDF2) must
  be replaced by bindings to this crate before real data is trusted to it.
