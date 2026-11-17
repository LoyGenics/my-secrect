//! Integration tests for crypto-core.
//! These are round-trip / tamper / determinism tests, NOT external
//! known-answer test vectors — do not present them as an audit or as
//! libsodium KATs. Real KATs (e.g. RFC 8439 / libsodium vectors) belong
//! here before any production claim.
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
    assert_eq!(derive_kek(b"pass", &salt).unwrap(), derive_kek(b"pass", &salt).unwrap());
    assert_ne!(derive_kek(b"pass", &salt).unwrap(), derive_kek(b"other", &salt).unwrap());
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
    assert_eq!(tag, sodiumoxide::crypto::secretstream::xchacha20poly1305::Tag::Final);
}
