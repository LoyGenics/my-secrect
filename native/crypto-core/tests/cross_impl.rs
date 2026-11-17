//! Cross-implementation tests: Rust opens what the TypeScript code wrote.
//!
//! - `chain-ts.json` was written by the REAL TypeScript vault modules
//!   (desktop, extension, mobile: createVault + upsertItem +
//!   exportEncrypted) by packages/crypto-adapters/scripts/gen-chain-vectors.ts.
//!   Here every layer is opened with this crate only: Argon2id KEK ->
//!   Account Master Key -> Vault Key -> Item Key -> item JSON, and the
//!   recovery-key path (base64url key -> SHA-256 -> AMK).
//! - `chain-rust.json` (written by examples/gen_chain_vectors.rs) is read
//!   back here only as a regression check; its real consumer is
//!   packages/crypto-adapters/tests/cross-impl.test.ts, which restores it
//!   through the real app code.
//! - `item-v2-vectors.json` / `hkdf-vectors.json` are deterministic
//!   known-answer vectors, also asserted on the TS side.
//!
//! Expected values come from the fixtures, never from this file. If a
//! test fails, an implementation or a parameter is wrong — do not edit
//! the fixture to make it pass.
use my_secrect_crypto_core::*;
use serde_json::Value;
use sodiumoxide::base64::{self, Variant};
use sodiumoxide::crypto::aead::xchacha20poly1305_ietf as aead;
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/crypto-vectors")
        .join(name);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture is JSON")
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("fixture field {key:?} must be a string"))
}

/// Standard base64 with padding: what packages/crypto-adapters `toBase64` writes.
fn b64(text: &str) -> Vec<u8> {
    base64::decode(text, Variant::Original).expect("standard padded base64")
}

fn hex32(text: &str) -> [u8; 32] {
    hex::decode(text).unwrap().try_into().expect("32-byte hex")
}

/// The key envelope stores nonce and ciphertext as two fields; this
/// crate takes `nonce || ciphertext+tag`.
fn joined(nonce_b64: &str, ct_b64: &str) -> Vec<u8> {
    let nonce = b64(nonce_b64);
    assert_eq!(nonce.len(), aead::NONCEBYTES, "nonces are 24 bytes");
    let mut out = nonce;
    out.extend_from_slice(&b64(ct_b64));
    out
}

fn assert_export_kdf_matches_this_crate(export: &Value) {
    let kdf = &export["kdf"];
    assert_eq!(kdf["name"], "argon2id");
    assert_eq!(kdf["opslimit"].as_u64(), Some(KDF_OPSLIMIT.0 as u64));
    assert_eq!(kdf["memlimit"].as_u64(), Some(KDF_MEMLIMIT.0 as u64));
    assert_eq!(kdf["salt_bytes"].as_u64(), Some(KDF_SALT_BYTES as u64));
    assert_eq!(kdf["output_bytes"].as_u64(), Some(32));
    assert_eq!(kdf["recovery_kek"], "sha256");
    assert_eq!(kdf["cipher"], "xchacha20poly1305-ietf");
    assert_eq!(kdf["nonce_bytes"].as_u64(), Some(aead::NONCEBYTES as u64));
    assert_eq!(
        kdf["encryption_version"].as_u64(),
        Some(ITEM_ENCRYPTION_V1 as u64)
    );
    assert_eq!(export["format_version"].as_u64(), Some(2));
}

/// (item_id, decrypted item JSON, unwrapped Item Key)
type OpenedItem = (String, Value, [u8; 32]);

/// Open a format_version 2 backup with the passphrase AND with the
/// recovery key; return the AMK, the Vault Key and every opened item.
fn open_backup(
    passphrase: &str,
    recovery_key_b64url: &str,
    export: &Value,
) -> ([u8; 32], [u8; 32], Vec<OpenedItem>) {
    assert_export_kdf_matches_this_crate(export);
    let keys = &export["keys"];
    let salt: [u8; KDF_SALT_BYTES] = b64(s(keys, "salt")).try_into().expect("16-byte salt");
    let kek = derive_kek(passphrase.as_bytes(), &salt).unwrap();
    let amk = unwrap_key(
        &kek,
        &joined(s(keys, "wrapped_master_nonce"), s(keys, "wrapped_master")),
    )
    .expect("passphrase KEK unwraps the Account Master Key");

    // Recovery path: unpadded base64url (toBase64Url), SHA-256, unwrap.
    let recovery_key: [u8; 32] = base64::decode(recovery_key_b64url, Variant::UrlSafeNoPadding)
        .expect("recovery key is unpadded base64url")
        .try_into()
        .expect("recovery key is 32 bytes");
    let amk_via_recovery = unwrap_key(
        &recovery_kek(&recovery_key),
        &joined(
            s(keys, "wrapped_recovery_nonce"),
            s(keys, "wrapped_recovery"),
        ),
    )
    .expect("recovery KEK unwraps the Account Master Key");
    assert_eq!(
        amk, amk_via_recovery,
        "both unlock paths reach the same AMK"
    );

    let vault_key = unwrap_key(
        &amk,
        &joined(s(keys, "wrapped_vault_nonce"), s(keys, "wrapped_vault")),
    )
    .expect("AMK unwraps the Vault Key");

    let mut items = Vec::new();
    for row in export["items"].as_array().expect("items array") {
        assert_eq!(row["encryption_version"].as_u64(), Some(1));
        // Export layout: base64(nonce(24) || ciphertext+tag) for both fields.
        let item_key = unwrap_key(&vault_key, &b64(s(row, "encrypted_item_key")))
            .expect("Vault Key unwraps the Item Key");
        let plaintext = decrypt_item(&item_key, &b64(s(row, "encrypted_payload")))
            .expect("Item Key decrypts the payload");
        let item: Value = serde_json::from_slice(&plaintext).expect("payload is JSON");
        // Same rule as every TS reader: the decrypted id must match the row.
        assert_eq!(item["id"], row["item_id"]);
        items.push((s(row, "item_id").to_owned(), item, item_key));
    }
    (amk, vault_key, items)
}

#[test]
fn ts_app_backups_open_in_rust() {
    init().unwrap();
    let f = fixture("chain-ts.json");
    let apps = f["apps"].as_object().expect("apps object");
    for name in ["desktop", "extension", "mobile"] {
        let app = &apps[name];
        let passphrase = s(app, "passphrase");
        let (_, _, items) = open_backup(passphrase, s(app, "recovery_key"), &app["export"]);

        // KEK byte-for-byte equal to the TS adapter's deriveKek.
        let salt: [u8; KDF_SALT_BYTES] = b64(s(&app["export"]["keys"], "salt")).try_into().unwrap();
        assert_eq!(
            hex::encode(derive_kek(passphrase.as_bytes(), &salt).unwrap()),
            s(app, "kek_hex"),
            "{name}: Argon2id KEK differs between TS and Rust"
        );

        let expected = app["expected_items"].as_array().unwrap();
        assert_eq!(items.len(), expected.len(), "{name}: item count");
        assert_eq!(items.len(), 2, "{name}: fixture holds two items");
        for want in expected {
            let (_, got, _) = items
                .iter()
                .find(|(id, _, _)| want["id"] == id.as_str())
                .unwrap_or_else(|| panic!("{name}: item {} missing", want["id"]));
            assert_eq!(
                got, want,
                "{name}: decrypted item differs from what the app wrote"
            );
        }
    }
    // The desktop passphrase is NFD on purpose; the Rust KEK above matched,
    // so neither side normalises.
    let desktop = s(&apps["desktop"], "passphrase");
    assert!(desktop
        .chars()
        .any(|c| ('\u{0300}'..='\u{036f}').contains(&c)));
}

#[test]
fn ts_backup_with_wrong_secrets_or_tampering_fails_closed() {
    init().unwrap();
    let f = fixture("chain-ts.json");
    let app = &f["apps"]["desktop"];
    let keys = &app["export"]["keys"];
    let salt: [u8; KDF_SALT_BYTES] = b64(s(keys, "salt")).try_into().unwrap();
    let wrapped_master = joined(s(keys, "wrapped_master_nonce"), s(keys, "wrapped_master"));

    // A different passphrase (here: one trailing space) fails the AEAD
    // tag. The NFC-vs-NFD case is asserted on the TS side, which has
    // String.prototype.normalize.
    let wrong_passphrase = format!("{} ", s(app, "passphrase"));
    let wrong = derive_kek(wrong_passphrase.as_bytes(), &salt).unwrap();
    assert!(matches!(
        unwrap_key(&wrong, &wrapped_master),
        Err(CryptoError::DecryptFailed)
    ));

    let mut tampered = wrapped_master.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    let kek = derive_kek(s(app, "passphrase").as_bytes(), &salt).unwrap();
    assert!(unwrap_key(&kek, &tampered).is_err());
}

#[test]
fn ts_v2_item_opens_in_rust_only_under_its_binding() {
    init().unwrap();
    let f = fixture("chain-ts.json");
    check_v2_section(&f["v2"]);
}

#[test]
fn rust_chain_fixture_still_opens() {
    init().unwrap();
    let f = fixture("chain-rust.json");
    let (amk, vault_key, items) =
        open_backup(s(&f, "passphrase"), s(&f, "recovery_key"), &f["export"]);
    let expected = &f["expected"];
    assert_eq!(hex::encode(amk), s(expected, "amk_hex"));
    assert_eq!(hex::encode(vault_key), s(expected, "vault_key_hex"));
    for want in expected["items"].as_array().unwrap() {
        let (_, got, item_key) = items
            .iter()
            .find(|(id, _, _)| want["item_id"] == id.as_str())
            .expect("item present");
        assert_eq!(hex::encode(item_key), s(want, "item_key_hex"));
        assert_eq!(got, &want["plaintext"]);
    }
    check_v2_section(&f["v2"]);
}

fn check_v2_section(v2: &Value) {
    assert_eq!(
        v2["encryption_version"].as_u64(),
        Some(ITEM_ENCRYPTION_V2 as u64)
    );
    let b = &v2["binding"];
    let binding = ItemBinding {
        vault_id: s(b, "vault_id"),
        item_id: s(b, "item_id"),
        revision: b["revision"].as_u64().unwrap(),
    };
    let vault_key = hex32(s(v2, "vault_key_hex"));
    let wrapped = b64(s(v2, "encrypted_item_key"));
    let payload = b64(s(v2, "encrypted_payload"));

    let item_key = unwrap_item_key_v2(&vault_key, &wrapped, &binding).expect("v2 unwrap");
    assert_eq!(hex::encode(item_key), s(v2, "item_key_hex"));
    let plaintext = decrypt_item_v2(&item_key, &payload, &binding).expect("v2 decrypt");
    let item: Value = serde_json::from_slice(&plaintext).unwrap();
    assert_eq!(item, v2["plaintext"]);

    // Every other binding fails: another item, vault or revision.
    let other_item = ItemBinding {
        item_id: "item_other",
        ..binding
    };
    let other_vault = ItemBinding {
        vault_id: "vault_other",
        ..binding
    };
    let older = ItemBinding {
        revision: binding.revision - 1,
        ..binding
    };
    for wrong in [other_item, other_vault, older] {
        assert!(unwrap_item_key_v2(&vault_key, &wrapped, &wrong).is_err());
        assert!(decrypt_item_v2(&item_key, &payload, &wrong).is_err());
    }
    // A v2 ciphertext relabelled as v1 (null AD) never opens.
    assert!(unwrap_key(&vault_key, &wrapped).is_err());
    assert!(decrypt_item(&item_key, &payload).is_err());
    // Payload and key-wrap ADs are distinct.
    assert!(decrypt_item_v2(&vault_key, &wrapped, &binding).is_err());
}

fn seq(start: u8, len: usize) -> Vec<u8> {
    (0..len).map(|i| start.wrapping_add(i as u8)).collect()
}

#[test]
fn item_v2_known_answer_vectors() {
    init().unwrap();
    let f = fixture("item-v2-vectors.json");
    assert_eq!(f["labels"]["payload"], ITEM_AD_V2_PAYLOAD_LABEL);
    assert_eq!(f["labels"]["key_wrap"], ITEM_AD_V2_KEY_WRAP_LABEL);
    let item_key = hex32(s(&f, "item_key_hex"));
    let vault_key = hex32(s(&f, "vault_key_hex"));
    // The fixture keys are the documented counting sequences.
    assert_eq!(item_key.to_vec(), seq(0x00, 32));
    assert_eq!(vault_key.to_vec(), seq(0x20, 32));

    let vectors = f["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 3);
    for v in vectors {
        let binding = ItemBinding {
            vault_id: s(v, "vault_id"),
            item_id: s(v, "item_id"),
            revision: v["revision"].as_u64().unwrap(),
        };
        let payload_ad = item_ad_v2(ItemAdPurpose::Payload, &binding).unwrap();
        let wrap_ad = item_ad_v2(ItemAdPurpose::KeyWrap, &binding).unwrap();
        assert_eq!(
            hex::encode(&payload_ad),
            s(v, "payload_ad_hex"),
            "{}",
            v["id"]
        );
        assert_eq!(
            hex::encode(&wrap_ad),
            s(v, "key_wrap_ad_hex"),
            "{}",
            v["id"]
        );

        // Fixed-nonce seal reproduces the vector exactly.
        let pn = aead::Nonce::from_slice(&hex::decode(s(v, "payload_nonce_hex")).unwrap()).unwrap();
        let wn =
            aead::Nonce::from_slice(&hex::decode(s(v, "key_wrap_nonce_hex")).unwrap()).unwrap();
        let ct = aead::seal(
            s(v, "plaintext").as_bytes(),
            Some(&payload_ad),
            &pn,
            &aead::Key(item_key),
        );
        assert_eq!(hex::encode(&ct), s(v, "payload_ciphertext_hex"));
        let wrapped = aead::seal(&item_key, Some(&wrap_ad), &wn, &aead::Key(vault_key));
        assert_eq!(hex::encode(&wrapped), s(v, "wrapped_item_key_hex"));

        // The public API opens the stored layout nonce || ciphertext+tag.
        let mut sealed_payload = pn.as_ref().to_vec();
        sealed_payload.extend_from_slice(&ct);
        let mut sealed_key = wn.as_ref().to_vec();
        sealed_key.extend_from_slice(&wrapped);
        assert_eq!(
            unwrap_item_key_v2(&vault_key, &sealed_key, &binding).unwrap(),
            item_key
        );
        assert_eq!(
            decrypt_item_v2(&item_key, &sealed_payload, &binding).unwrap(),
            s(v, "plaintext").as_bytes()
        );
        assert!(decrypt_item(&item_key, &sealed_payload).is_err());
    }
}

#[test]
fn item_ad_v2_rejects_out_of_range_bindings() {
    let ok = ItemBinding {
        vault_id: "v",
        item_id: "i",
        revision: 0,
    };
    assert!(item_ad_v2(ItemAdPurpose::Payload, &ok).is_ok());
    let long = "x".repeat(ITEM_AD_V2_MAX_ID_BYTES + 1);
    for bad in [
        ItemBinding { vault_id: "", ..ok },
        ItemBinding { item_id: "", ..ok },
        ItemBinding {
            item_id: &long,
            ..ok
        },
        ItemBinding {
            revision: ITEM_AD_V2_MAX_REVISION + 1,
            ..ok
        },
    ] {
        assert!(matches!(
            item_ad_v2(ItemAdPurpose::Payload, &bad),
            Err(CryptoError::InvalidInput(_))
        ));
    }
    // Length prefixes keep ("ab","c") and ("a","bc") apart.
    let a = item_ad_v2(
        ItemAdPurpose::Payload,
        &ItemBinding {
            vault_id: "ab",
            item_id: "c",
            revision: 1,
        },
    )
    .unwrap();
    let b = item_ad_v2(
        ItemAdPurpose::Payload,
        &ItemBinding {
            vault_id: "a",
            item_id: "bc",
            revision: 1,
        },
    )
    .unwrap();
    assert_ne!(a, b);
}

#[test]
fn hkdf_matches_shared_vectors_and_rfc5869_case_3() {
    // RFC 5869 A.3: IKM = 0x0b * 22, salt = empty, info = empty, L = 42.
    // An empty salt is HashLen zeros, so None and Some(&[0; 32]) agree.
    let ikm = [0x0bu8; 22];
    let rfc =
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8";
    assert_eq!(hex::encode(hkdf_sha256(&ikm, None, b"", 42)), rfc);
    assert_eq!(
        hex::encode(hkdf_sha256(&ikm, Some(&[0u8; 32][..]), b"", 42)),
        rfc
    );

    let f = fixture("hkdf-vectors.json");
    let ikm = hex::decode(s(&f, "ikm_hex")).unwrap();
    for v in f["vectors"].as_array().unwrap() {
        let len = v["length"].as_u64().unwrap() as usize;
        assert_eq!(
            hex::encode(hkdf_sha256(&ikm, None, s(v, "info").as_bytes(), len)),
            s(v, "okm_hex")
        );
    }
}

#[test]
fn recovery_kek_is_sha256_of_the_key() {
    init().unwrap();
    // FIPS 180-2 style check on a fixed input: SHA-256(0x00 * 32).
    assert_eq!(
        hex::encode(recovery_kek(&[0u8; 32])),
        "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
    );
    let f = fixture("chain-rust.json");
    let rk: [u8; 32] = base64::decode(s(&f, "recovery_key"), Variant::UrlSafeNoPadding)
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        hex::encode(recovery_kek(&rk)),
        s(&f["expected"], "recovery_kek_hex")
    );
}

#[test]
fn unwrap_key_rejects_non_32_byte_plaintext() {
    init().unwrap();
    let kek = [7u8; 32];
    let sealed = encrypt_item(&kek, &[1u8; 31]);
    assert!(matches!(
        unwrap_key(&kek, &sealed),
        Err(CryptoError::InvalidInput(_))
    ));
}
