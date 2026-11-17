//! my-secrect crypto-core — the audited boundary.
//!
//! Small library, stable API, independently testable. Pure crypto only:
//! no network, no storage, no UI. All other code (TypeScript adapters,
//! Rails, Tauri) must go through this API and must never hand-roll crypto.
//!
//! Primitives (all via libsodium through `sodiumoxide`, except HKDF):
//! - KDF: libsodium `crypto_pwhash` — Argon2id, versioned parameters.
//! - Item AEAD: XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf`).
//! - File streaming: libsodium `secretstream` (XChaCha20-Poly1305).
//! - Subkeys: HKDF-SHA-256.
//! - Randomness: libsodium CSPRNG (`randombytes`).
//!
//! Versioning: every format carries `CRYPTO_FORMAT_VERSION`. Changing a
//! parameter or layout bumps the version and needs new test vectors.
//! Item encryption v2 (AD-bound, see `item_ad_v2`) exists as primitives
//! only; v1 (`encrypt_item`, no additional data) stays the default writer.
//! NO audit has been performed on this crate. Do not claim otherwise.

use hkdf::Hkdf;
use sha2::Sha256;
use sodiumoxide::crypto::aead::xchacha20poly1305_ietf as aead;
use sodiumoxide::crypto::hash::sha256;
// `sodiumoxide::crypto::pwhash` on its own re-exports scryptsalsa208sha256
// (sodiumoxide 0.2.7, src/crypto/pwhash/mod.rs:
// `pub use self::scryptsalsa208sha256::*;`). Always name argon2id13.
use sodiumoxide::crypto::pwhash::argon2id13 as pwhash;
use sodiumoxide::crypto::secretstream::xchacha20poly1305 as stream;
use sodiumoxide::randombytes;
use thiserror::Error;

pub const CRYPTO_FORMAT_VERSION: u32 = 1;

/// Argon2id parameters, v1 — THE single locked profile for the whole
/// vault (see specs/key-management.md and specs/encryption-format.md).
/// These are libsodium's INTERACTIVE limits: OPSLIMIT_INTERACTIVE = 2,
/// MEMLIMIT_INTERACTIVE = 67108864 bytes (64 MiB), ALG_ARGON2ID13,
/// salt 16 bytes, output 32 bytes. The TypeScript adapter
/// (packages/crypto-adapters/src/index.ts, ARGON2ID_PARAMS) uses exactly
/// these values, so a KEK derived on one platform unwraps keys created
/// on the other. Phase B fixed this: Rust previously used SENSITIVE,
/// which produced incompatible KEKs (security-review.md H3).
/// Never change these values without bumping CRYPTO_FORMAT_VERSION and
/// writing new test vectors in tests/crypto-vectors/argon2id-vectors.json.
pub const KDF_OPSLIMIT: pwhash::OpsLimit = pwhash::OPSLIMIT_INTERACTIVE;
pub const KDF_MEMLIMIT: pwhash::MemLimit = pwhash::MEMLIMIT_INTERACTIVE;
/// Argon2id salt length: 16 bytes, the TS adapter's `ARGON2ID_PARAMS.saltBytes`.
pub const KDF_SALT_BYTES: usize = pwhash::SALTBYTES;

// Compile-time pins. If `pwhash` is ever re-pointed at another module (the
// scrypt mix-up fixed in 4adb39d had 32-byte salts and opslimit 524288) or
// a libsodium upgrade moves the INTERACTIVE constants, the crate stops
// compiling instead of silently deriving KEKs the TS side cannot match.
const _: () = assert!(pwhash::VARIANT == 2, "crypto_pwhash_ALG_ARGON2ID13");
const _: () = assert!(KDF_OPSLIMIT.0 == 2, "OPSLIMIT_INTERACTIVE");
const _: () = assert!(KDF_MEMLIMIT.0 == 67_108_864, "MEMLIMIT_INTERACTIVE");
const _: () = assert!(KDF_SALT_BYTES == 16, "Argon2id salt bytes");
const _: () = assert!(aead::KEYBYTES == 32 && aead::NONCEBYTES == 24 && aead::TAGBYTES == 16);

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("decryption failed: authentication tag mismatch or corrupt ciphertext")]
    DecryptFailed,
    #[error("invalid input: {0}")]
    InvalidInput(&'static str),
    #[error("libsodium init failed")]
    InitFailed,
}

pub type Result<T> = std::result::Result<T, CryptoError>;

/// Must be called once before any other function. Safe to call repeatedly.
pub fn init() -> Result<()> {
    sodiumoxide::init().map_err(|_| CryptoError::InitFailed)
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    randombytes::randombytes(n)
}

/// Derive a 32-byte Key Encryption Key from a master passphrase.
/// Salt MUST be 16 random bytes, stored alongside the wrapped key.
/// `passphrase` must be the exact UTF-8 bytes the TS side gets from
/// `TextEncoder`. Neither side applies Unicode normalisation, so the same
/// passphrase typed in another normalisation form (NFC vs NFD) is a
/// different passphrase — see specs/key-management.md.
pub fn derive_kek(passphrase: &[u8], salt: &[u8; KDF_SALT_BYTES]) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    pwhash::derive_key(
        &mut key,
        passphrase,
        &pwhash::Salt::from_slice(salt).ok_or(CryptoError::InvalidInput("salt length"))?,
        KDF_OPSLIMIT,
        KDF_MEMLIMIT,
    )
    .map_err(|_| CryptoError::InvalidInput("argon2id derive_key failed"))?;
    Ok(key)
}

/// HKDF-SHA-256 subkey derivation. `info` binds the subkey to its purpose
/// (e.g. "my-secrect/item-key/v1"). Never reuse one key for two purposes.
pub fn hkdf_sha256(ikm: &[u8], salt: Option<&[u8]>, info: &[u8], len: usize) -> Vec<u8> {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut out = vec![0u8; len];
    hk.expand(info, &mut out)
        .expect("hkdf expand: length is caller-controlled and small");
    out
}

/// XChaCha20-Poly1305 IETF seal with a fresh random nonce. Output layout
/// `nonce (24B) || ciphertext+tag`. `ad` is `None` for v1 and the
/// `item_ad_v2` bytes for v2. libsodium treats `None` and an empty AD
/// alike (adlen 0); a v2 AD is never empty, so v1 and v2 tags never cross.
fn seal(key: &[u8; 32], plaintext: &[u8], ad: Option<&[u8]>) -> Vec<u8> {
    let nonce = aead::gen_nonce();
    let ct = aead::seal(plaintext, ad, &nonce, &aead::Key::from_slice(key).unwrap());
    let mut out = Vec::with_capacity(aead::NONCEBYTES + ct.len());
    out.extend_from_slice(nonce.as_ref());
    out.extend_from_slice(&ct);
    out
}

fn open(key: &[u8; 32], sealed: &[u8], ad: Option<&[u8]>) -> Result<Vec<u8>> {
    if sealed.len() < aead::NONCEBYTES {
        return Err(CryptoError::InvalidInput("sealed blob too short"));
    }
    let (nonce, ct) = sealed.split_at(aead::NONCEBYTES);
    aead::open(
        ct,
        ad,
        &aead::Nonce::from_slice(nonce).ok_or(CryptoError::InvalidInput("nonce length"))?,
        &aead::Key::from_slice(key).unwrap(),
    )
    .map_err(|_| CryptoError::DecryptFailed)
}

/// Encrypt one item's plaintext JSON with a fresh per-item key (item
/// format v1: no additional data). Output layout:
/// `nonce (24B) || ciphertext+tag`. Nonce is random per call.
pub fn encrypt_item(item_key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    seal(item_key, plaintext, None)
}

/// Decrypt `encrypt_item` output. Any tampering fails closed.
pub fn decrypt_item(item_key: &[u8; 32], sealed: &[u8]) -> Result<Vec<u8>> {
    open(item_key, sealed, None)
}

/// Wrap (encrypt) a 32-byte key with a wrapping key. Same AEAD, fresh nonce.
pub fn wrap_key(wrapping_key: &[u8; 32], key: &[u8; 32]) -> Vec<u8> {
    encrypt_item(wrapping_key, key)
}

pub fn unwrap_key(wrapping_key: &[u8; 32], sealed: &[u8]) -> Result<[u8; 32]> {
    let pt = decrypt_item(wrapping_key, sealed)?;
    pt.try_into()
        .map_err(|_| CryptoError::InvalidInput("unwrapped key is not 32 bytes"))
}

/// Recovery KEK = SHA-256(recovery key bytes) via libsodium
/// `crypto_hash_sha256`, the same call the TS vaults make through
/// `sha256()` in packages/crypto-adapters. The recovery key is 32 random
/// bytes (shown once as unpadded base64url), so a fast hash is enough:
/// there is no low-entropy secret to stretch. It wraps the Account
/// Master Key with `wrap_key`.
pub fn recovery_kek(recovery_key: &[u8; 32]) -> [u8; 32] {
    sha256::hash(recovery_key).0
}

// ---------------------------------------------------------------------------
// Item encryption v2 — additional data binds a ciphertext to its slot.
//
// Primitives only. Nothing writes v2 by default; v1 stays the writer
// until the coordinated rollout in specs/encryption-format.md. Mirrored
// byte-for-byte by `itemAdV2` & co. in packages/crypto-adapters/src/index.ts;
// shared vectors in tests/crypto-vectors/item-v2-vectors.json.
//
//   AD = u32be(len(label))    || label
//     || u32be(len(vault_id)) || vault_id   (UTF-8, 1..=1024 bytes)
//     || u32be(len(item_id))  || item_id    (UTF-8, 1..=1024 bytes)
//     || u64be(revision)                    (0..=2^53-1)
//
// Length prefixes make the encoding injective (an id cannot smuggle a
// separator). The revision cap is JavaScript's largest safe integer so
// the TS side can always reproduce the AD.
// ---------------------------------------------------------------------------

/// Item ciphertext format v1 (no additional data). The default writer.
pub const ITEM_ENCRYPTION_V1: u32 = 1;
/// Item ciphertext format v2 (AD-bound). Not written by default.
pub const ITEM_ENCRYPTION_V2: u32 = 2;
/// AD label for an item payload encrypted under its Item Key.
pub const ITEM_AD_V2_PAYLOAD_LABEL: &str = "my-secrect/item-payload/v2";
/// AD label for an Item Key wrapped under the Vault Key.
pub const ITEM_AD_V2_KEY_WRAP_LABEL: &str = "my-secrect/item-key-wrap/v2";
/// Longest vault_id / item_id accepted, in UTF-8 bytes.
pub const ITEM_AD_V2_MAX_ID_BYTES: usize = 1024;
/// Largest revision accepted: 2^53 - 1 (`Number.MAX_SAFE_INTEGER`).
pub const ITEM_AD_V2_MAX_REVISION: u64 = (1 << 53) - 1;

/// Which slot an AD belongs to. Payload and key-wrap ADs differ, so a
/// wrapped key can never stand in for a payload or the reverse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemAdPurpose {
    Payload,
    KeyWrap,
}

/// Where a v2 ciphertext belongs. Ids are compared byte-for-byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItemBinding<'a> {
    pub vault_id: &'a str,
    pub item_id: &'a str,
    pub revision: u64,
}

fn push_length_prefixed(out: &mut Vec<u8>, field: &[u8]) {
    // Every field is bounded to <= 1024 bytes before this, so the u32
    // length never truncates.
    out.extend_from_slice(&(field.len() as u32).to_be_bytes());
    out.extend_from_slice(field);
}

/// Build the v2 additional data for one item slot.
pub fn item_ad_v2(purpose: ItemAdPurpose, binding: &ItemBinding<'_>) -> Result<Vec<u8>> {
    for id in [binding.vault_id, binding.item_id] {
        if id.is_empty() || id.len() > ITEM_AD_V2_MAX_ID_BYTES {
            return Err(CryptoError::InvalidInput(
                "v2 id must be 1..=1024 UTF-8 bytes",
            ));
        }
    }
    if binding.revision > ITEM_AD_V2_MAX_REVISION {
        return Err(CryptoError::InvalidInput("v2 revision exceeds 2^53-1"));
    }
    let label = match purpose {
        ItemAdPurpose::Payload => ITEM_AD_V2_PAYLOAD_LABEL,
        ItemAdPurpose::KeyWrap => ITEM_AD_V2_KEY_WRAP_LABEL,
    };
    let mut ad =
        Vec::with_capacity(12 + label.len() + binding.vault_id.len() + binding.item_id.len() + 8);
    push_length_prefixed(&mut ad, label.as_bytes());
    push_length_prefixed(&mut ad, binding.vault_id.as_bytes());
    push_length_prefixed(&mut ad, binding.item_id.as_bytes());
    ad.extend_from_slice(&binding.revision.to_be_bytes());
    Ok(ad)
}

/// v2 item payload encrypt under the Item Key. Same layout as v1.
pub fn encrypt_item_v2(
    item_key: &[u8; 32],
    plaintext: &[u8],
    binding: &ItemBinding<'_>,
) -> Result<Vec<u8>> {
    let ad = item_ad_v2(ItemAdPurpose::Payload, binding)?;
    Ok(seal(item_key, plaintext, Some(&ad)))
}

/// v2 item payload decrypt. Fails on tampering OR on a binding that
/// differs from the writer's (other item, other vault, other revision).
pub fn decrypt_item_v2(
    item_key: &[u8; 32],
    sealed: &[u8],
    binding: &ItemBinding<'_>,
) -> Result<Vec<u8>> {
    let ad = item_ad_v2(ItemAdPurpose::Payload, binding)?;
    open(item_key, sealed, Some(&ad))
}

/// v2 Item Key wrap under the Vault Key.
pub fn wrap_item_key_v2(
    vault_key: &[u8; 32],
    item_key: &[u8; 32],
    binding: &ItemBinding<'_>,
) -> Result<Vec<u8>> {
    let ad = item_ad_v2(ItemAdPurpose::KeyWrap, binding)?;
    Ok(seal(vault_key, item_key, Some(&ad)))
}

/// v2 Item Key unwrap. Fails on tampering, a binding mismatch, or a
/// plaintext that is not 32 bytes.
pub fn unwrap_item_key_v2(
    vault_key: &[u8; 32],
    sealed: &[u8],
    binding: &ItemBinding<'_>,
) -> Result<[u8; 32]> {
    let ad = item_ad_v2(ItemAdPurpose::KeyWrap, binding)?;
    open(vault_key, sealed, Some(&ad))?
        .try_into()
        .map_err(|_| CryptoError::InvalidInput("unwrapped key is not 32 bytes"))
}

/// File streaming encryption (libsodium secretstream).
/// The caller stores the 24-byte header with the blob manifest; every
/// chunk is authenticated, in order, and the final chunk carries Tag::Final.
pub struct EncryptStream {
    state: stream::Stream<stream::Push>,
    pub header: stream::Header,
}

impl EncryptStream {
    pub fn new(file_key: &[u8; 32]) -> Self {
        let (state, header) = stream::Stream::init_push(
            &stream::Key::from_slice(file_key).expect("file key is 32 bytes"),
        )
        .expect("secretstream init_push cannot fail with a valid key");
        Self { state, header }
    }
    pub fn push(&mut self, chunk: &[u8], is_final: bool) -> Vec<u8> {
        let tag = if is_final {
            stream::Tag::Final
        } else {
            stream::Tag::Message
        };
        self.state
            .push(chunk, None, tag)
            .expect("secretstream push cannot fail with a valid key")
    }
}

pub struct DecryptStream {
    state: stream::Stream<stream::Pull>,
}

impl DecryptStream {
    pub fn new(file_key: &[u8; 32], header: &stream::Header) -> Result<Self> {
        let state = stream::Stream::init_pull(
            header,
            &stream::Key::from_slice(file_key).expect("file key is 32 bytes"),
        )
        .map_err(|_| CryptoError::InvalidInput("invalid secretstream header"))?;
        Ok(Self { state })
    }
    /// Returns (plaintext, tag). A chunk out of order, truncated, or
    /// tampered with fails here — never silently accept partial data.
    pub fn pull(&mut self, sealed_chunk: &[u8]) -> Result<(Vec<u8>, stream::Tag)> {
        self.state
            .pull(sealed_chunk, None)
            .map_err(|_| CryptoError::DecryptFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kek_is_deterministic_for_same_inputs_and_differs_by_salt() {
        init().unwrap();
        let salt = [7u8; pwhash::SALTBYTES];
        let a = derive_kek(b"correct horse battery staple", &salt).unwrap();
        let b = derive_kek(b"correct horse battery staple", &salt).unwrap();
        assert_eq!(a, b);
        let other_salt = [8u8; pwhash::SALTBYTES];
        assert_ne!(
            a,
            derive_kek(b"correct horse battery staple", &other_salt).unwrap()
        );
        assert_ne!(a, derive_kek(b"different passphrase", &salt).unwrap());
    }

    #[test]
    fn item_roundtrip_and_tamper_rejection() {
        init().unwrap();
        let key = [42u8; 32];
        let sealed = encrypt_item(&key, b"{\"title\":\"secret\"}");
        assert_eq!(
            decrypt_item(&key, &sealed).unwrap(),
            b"{\"title\":\"secret\"}"
        );
        let mut tampered = sealed.clone();
        tampered[30] ^= 1;
        assert!(matches!(
            decrypt_item(&key, &tampered),
            Err(CryptoError::DecryptFailed)
        ));
        assert!(matches!(
            decrypt_item(&[1u8; 32], &sealed),
            Err(CryptoError::DecryptFailed)
        ));
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        init().unwrap();
        let kek = [3u8; 32];
        let item_key = [9u8; 32];
        assert_eq!(
            unwrap_key(&kek, &wrap_key(&kek, &item_key)).unwrap(),
            item_key
        );
    }

    #[test]
    fn hkdf_binds_subkeys_to_purpose() {
        let ikm = [5u8; 32];
        assert_ne!(
            hkdf_sha256(&ikm, None, b"my-secrect/item-key/v1", 32),
            hkdf_sha256(&ikm, None, b"my-secrect/file-key/v1", 32)
        );
        assert_eq!(
            hkdf_sha256(&ikm, None, b"my-secrect/item-key/v1", 32),
            hkdf_sha256(&ikm, None, b"my-secrect/item-key/v1", 32)
        );
    }

    #[test]
    fn secretstream_roundtrip_with_final_tag() {
        init().unwrap();
        let file_key = [11u8; 32];
        let mut enc = EncryptStream::new(&file_key);
        let c1 = enc.push(b"hello ", false);
        let c2 = enc.push(b"vault", true);
        let mut dec = DecryptStream::new(&file_key, &enc.header).unwrap();
        let (p1, t1) = dec.pull(&c1).unwrap();
        let (p2, t2) = dec.pull(&c2).unwrap();
        assert_eq!(p1, b"hello ");
        assert_eq!(p2, b"vault");
        assert_eq!(t1, stream::Tag::Message);
        assert_eq!(t2, stream::Tag::Final);
    }
}
