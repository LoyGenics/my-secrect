//! Integration tests for crypto-core.
//!
//! The `*_matches_shared_vectors` tests below ARE known-answer tests:
//! they assert the exact bytes in tests/crypto-vectors/argon2id-vectors.json,
//! which were computed with libsodium itself (PyNaCl 1.6.2, bundled
//! libsodium — see that file's `_generated` note) and are asserted with
//! the same inputs on the TypeScript side by
//! tests/crypto-vectors/argon2id-vectors.test.mjs. If the Argon2id test
//! fails, TS and Rust derive different KEKs and vaults stop unlocking
//! cross-platform — do NOT "fix" it by editing the expected hex.
//! The remaining tests are round-trip / tamper / determinism checks.
//! None of this is an audit. Do not claim otherwise.
use my_secrect_crypto_core::*;
use sodiumoxide::crypto::pwhash;

#[test]
fn item_encrypt_decrypt_roundtrip() {
    init().unwrap();
    let key = [0x2au8; 32];
    let sealed = encrypt_item(&key, b"vault item json");
    assert_eq!(decrypt_item(&key, &sealed).unwrap(), b"vault item json");
}

#[test]
fn tampered_ciphertext_fails_closed() {
    init().unwrap();
    let key = [0x2au8; 32];
    let mut sealed = encrypt_item(&key, b"vault item json");
    sealed[sealed.len() - 1] ^= 0xff;
    assert!(decrypt_item(&key, &sealed).is_err());
}

#[test]
fn kek_depends_on_passphrase_and_salt() {
    init().unwrap();
    let salt = [1u8; pwhash::SALTBYTES];
    assert_eq!(
        derive_kek(b"pass", &salt).unwrap(),
        derive_kek(b"pass", &salt).unwrap()
    );
    assert_ne!(
        derive_kek(b"pass", &salt).unwrap(),
        derive_kek(b"other", &salt).unwrap()
    );
}

/// Decode a hex string from tests/crypto-vectors/argon2id-vectors.json.
fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s).expect("vector hex must be valid")
}

/// The locked Argon2id profile is INTERACTIVE (opslimit 2, memlimit
/// 64 MiB) — the same profile the TypeScript adapter uses. These tests
/// fail if crypto-core ever drifts back to SENSITIVE or any other
/// parameters, because the KEK bytes would change.
#[test]
fn argon2id_kek_matches_shared_vectors() {
    init().unwrap();
    // Vector kek-1: passphrase "correct horse battery staple",
    // salt 00..0f. Vector kek-2: passphrase "my-secrect test passphrase",
    // salt 0x2a * 16. Expected KEKs are copied verbatim from
    // tests/crypto-vectors/argon2id-vectors.json — never edit them to
    // make this test pass.
    let cases = [
        (
            "correct horse battery staple",
            "000102030405060708090a0b0c0d0e0f",
            "c05ce4c4dd7e0e45ee6011cc59d068ade47df1b01fc0cf9cd4678bdf68a5b7b0",
        ),
        (
            "my-secrect test passphrase",
            "2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a",
            "e3da58d3edd0e289d9f09f0bea83a675f1dea7d78300de48057b396889c253fa",
        ),
    ];
    for (passphrase, salt_hex, expected_kek_hex) in cases {
        let salt_vec = hex_bytes(salt_hex);
        let salt: [u8; pwhash::SALTBYTES] = salt_vec.try_into().expect("salt is 16 bytes");
        let kek = derive_kek(passphrase.as_bytes(), &salt).unwrap();
        assert_eq!(
            hex::encode(kek),
            expected_kek_hex,
            "KEK mismatch for passphrase {passphrase:?}"
        );
    }
}

/// XChaCha20-Poly1305 known answer: the sealed blob is nonce ||
/// ciphertext+tag from the shared vectors file (key 00..1f, nonce
/// 00..17, plaintext "vault item json"). Decrypting it must reproduce
/// the plaintext — this pins the AEAD layout across TS and Rust.
#[test]
fn xchacha_seal_matches_shared_vector() {
    init().unwrap();
    let key_vec = hex_bytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    let key: [u8; 32] = key_vec.try_into().expect("key is 32 bytes");
    let mut sealed = hex_bytes("000102030405060708090a0b0c0d0e0f1011121314151617");
    sealed.extend_from_slice(&hex_bytes(
        "e8a37a13e4f2e4da562906a4b83dc68c707f60973f28fc9e984b655357eae5",
    ));
    assert_eq!(decrypt_item(&key, &sealed).unwrap(), b"vault item json");
    // And a single flipped tag byte still fails closed.
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff;
    assert!(decrypt_item(&key, &tampered).is_err());
}

#[test]
fn secretstream_file_roundtrip() {
    init().unwrap();
    let key = [0x3cu8; 32];
    let mut enc = EncryptStream::new(&key);
    let header = enc.header.clone();
    let c1 = enc.push(b"chunk one ", false);
    let c2 = enc.push(b"chunk two", true);
    let mut dec = DecryptStream::new(&key, &header).unwrap();
    assert_eq!(dec.pull(&c1).unwrap().0, b"chunk one ");
    let (p2, tag) = dec.pull(&c2).unwrap();
    assert_eq!(p2, b"chunk two");
    assert_eq!(
        tag,
        sodiumoxide::crypto::secretstream::xchacha20poly1305::Tag::Final
    );
}
