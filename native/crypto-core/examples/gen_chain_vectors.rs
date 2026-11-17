//! Writes the Rust-generated cross-implementation fixtures into
//! tests/crypto-vectors/ (repo root):
//!
//! - `chain-rust.json`: a complete v1 vault built ONLY with this crate —
//!   passphrase -> Argon2id KEK -> Account Master Key -> Vault Key ->
//!   Item Keys -> item JSON, plus the recovery-key wrap — laid out as the
//!   apps' encrypted backup (`format_version` 2), and one v2 (AD-bound)
//!   item. Keys and nonces are random, so every run changes every value.
//!   The TypeScript side restores it with the REAL desktop, extension and
//!   mobile vault code (packages/crypto-adapters/tests/cross-impl.test.ts).
//! - `item-v2-vectors.json`: fixed-key, fixed-nonce known-answer vectors
//!   for the v2 additional data and AEAD output. Deterministic: rerunning
//!   must reproduce the file byte-for-byte.
//! - `hkdf-vectors.json`: HKDF-SHA-256 (zero salt) vectors for the TS
//!   adapter's `hkdf`. Deterministic.
//!
//! Run from native/crypto-core: `cargo run --example gen_chain_vectors`.
//! Never hand-edit the output: if a consumer disagrees, one of the
//! implementations is wrong.
use my_secrect_crypto_core::*;
use serde_json::{json, Value};
use sodiumoxide::base64::{self, Variant};
use sodiumoxide::crypto::aead::xchacha20poly1305_ietf as aead;
use std::path::PathBuf;

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/crypto-vectors")
}

fn write_json(name: &str, value: &Value) {
    let path = out_dir().join(name);
    let mut text = serde_json::to_string_pretty(value).expect("serialise fixture");
    text.push('\n');
    std::fs::write(&path, text).expect("write fixture");
    println!("wrote {}", path.display());
}

fn b64(bytes: &[u8]) -> String {
    base64::encode(bytes, Variant::Original)
}

fn random32() -> [u8; 32] {
    random_bytes(32).try_into().expect("32 random bytes")
}

/// Split this crate's `nonce || ciphertext+tag` into the two base64
/// fields the key envelope stores separately.
fn split_sealed(sealed: &[u8]) -> (String, String) {
    let (nonce, rest) = sealed.split_at(aead::NONCEBYTES);
    (b64(nonce), b64(rest))
}

/// A VaultItem (packages/core/src/types.ts) the apps accept on restore.
fn vault_item(id: &str, title: &str, password: &str) -> Value {
    json!({
        "id": id,
        "type": "login",
        "schema_version": 1,
        "title": title,
        "fields": { "username": "ada", "password": password, "url": "https://example.test" },
        "tags": ["cross-impl"],
        "relations": [],
        "attachments": [],
        "favorite": false,
        "created_at": "2026-11-17T00:00:00.000Z",
        "updated_at": "2026-11-17T00:00:00.000Z",
        "deleted_at": null
    })
}

fn chain_fixture() -> Value {
    // Non-ASCII on purpose (NFC Vietnamese + a non-BMP emoji): the KEK
    // input is the UTF-8 bytes, so this pins the encoding on both sides.
    let passphrase = "Mật khẩu kiểm thử Rust→TS 🔐";
    let salt: [u8; KDF_SALT_BYTES] = random_bytes(KDF_SALT_BYTES).try_into().unwrap();
    let kek = derive_kek(passphrase.as_bytes(), &salt).expect("argon2id");
    let amk = random32();
    let vault_key = random32();
    let recovery_key = random32();

    let wrapped_master = wrap_key(&kek, &amk);
    let wrapped_vault = wrap_key(&amk, &vault_key);
    let wrapped_recovery = wrap_key(&recovery_kek(&recovery_key), &amk);
    let (wm_nonce, wm) = split_sealed(&wrapped_master);
    let (wv_nonce, wv) = split_sealed(&wrapped_vault);
    let (wr_nonce, wr) = split_sealed(&wrapped_recovery);

    let mut export_items = Vec::new();
    let mut expected_items = Vec::new();
    for (n, (id, title, password)) in [
        ("item_rust_01", "Rust-written login", "rust-secret-1"),
        ("item_rust_02", "Đăng nhập do Rust ghi ✓", "rust-secret-2 ✓"),
    ]
    .into_iter()
    .enumerate()
    {
        let item = vault_item(id, title, password);
        let item_key = random32();
        let payload = encrypt_item(&item_key, &serde_json::to_vec(&item).unwrap());
        let wrapped_item_key = wrap_key(&vault_key, &item_key);
        export_items.push(json!({
            "item_id": id,
            "revision": n + 1,
            "encrypted_payload": b64(&payload),
            "encrypted_item_key": b64(&wrapped_item_key),
            "encryption_version": ITEM_ENCRYPTION_V1,
        }));
        expected_items.push(json!({
            "item_id": id,
            "item_key_hex": hex::encode(item_key),
            "plaintext": item,
        }));
    }

    // One v2 item under the same Vault Key.
    let v2_vault_id = "vault_rust_v2";
    let v2_item_id = "item_rust_v2";
    let v2_revision = 7u64;
    let binding = ItemBinding {
        vault_id: v2_vault_id,
        item_id: v2_item_id,
        revision: v2_revision,
    };
    let v2_item = vault_item(v2_item_id, "Rust-written v2 item", "rust-v2-secret");
    let v2_item_key = random32();
    let v2_payload = encrypt_item_v2(
        &v2_item_key,
        &serde_json::to_vec(&v2_item).unwrap(),
        &binding,
    )
    .unwrap();
    let v2_wrapped = wrap_item_key_v2(&vault_key, &v2_item_key, &binding).unwrap();

    json!({
        "_comment": "Cross-implementation fixture written by native/crypto-core (Rust, sodiumoxide/libsodium) ONLY. Read by packages/crypto-adapters/tests/cross-impl.test.ts, which restores `export` through the real desktop, extension and mobile vault modules, and re-checked by native/crypto-core/tests/cross_impl.rs.",
        "_generated": "cd native/crypto-core && cargo run --example gen_chain_vectors. Random keys and nonces: regenerating changes every value. NEVER hand-edit; if a reader disagrees, an implementation is wrong.",
        "generator": "native/crypto-core",
        "passphrase": passphrase,
        "recovery_key": base64::encode(recovery_key, Variant::UrlSafeNoPadding),
        "expected": {
            "kek_hex": hex::encode(kek),
            "amk_hex": hex::encode(amk),
            "vault_key_hex": hex::encode(vault_key),
            "recovery_kek_hex": hex::encode(recovery_kek(&recovery_key)),
            "items": expected_items,
        },
        "export": {
            "format": "my-secrect-vault-export",
            "format_version": 2,
            "exported_at": "2026-11-17T00:00:00.000Z",
            "vault_id": "rust-fixture-vault",
            "kdf": {
                "name": "argon2id",
                "opslimit": KDF_OPSLIMIT.0,
                "memlimit": KDF_MEMLIMIT.0,
                "salt_bytes": KDF_SALT_BYTES,
                "output_bytes": 32,
                "recovery_kek": "sha256",
                "cipher": "xchacha20poly1305-ietf",
                "nonce_bytes": aead::NONCEBYTES,
                "encryption_version": ITEM_ENCRYPTION_V1,
            },
            "keys": {
                "salt": b64(&salt),
                "wrapped_master": wm,
                "wrapped_master_nonce": wm_nonce,
                "wrapped_vault": wv,
                "wrapped_vault_nonce": wv_nonce,
                "wrapped_recovery": wr,
                "wrapped_recovery_nonce": wr_nonce,
            },
            "items": export_items,
            "relations_included": true,
        },
        "v2": {
            "binding": { "vault_id": v2_vault_id, "item_id": v2_item_id, "revision": v2_revision },
            "vault_key_hex": hex::encode(vault_key),
            "item_key_hex": hex::encode(v2_item_key),
            "encrypted_payload": b64(&v2_payload),
            "encrypted_item_key": b64(&v2_wrapped),
            "encryption_version": ITEM_ENCRYPTION_V2,
            "plaintext": v2_item,
        },
    })
}

fn seq(start: u8, len: usize) -> Vec<u8> {
    (0..len).map(|i| start.wrapping_add(i as u8)).collect()
}

/// Fixed-nonce v2 known-answer vectors. The library never takes a
/// caller nonce; only this generator does, through sodiumoxide directly.
fn item_v2_vectors() -> Value {
    let item_key: [u8; 32] = seq(0x00, 32).try_into().unwrap();
    let vault_key: [u8; 32] = seq(0x20, 32).try_into().unwrap();
    let payload_nonce = aead::Nonce::from_slice(&seq(0x40, 24)).unwrap();
    let wrap_nonce = aead::Nonce::from_slice(&seq(0x60, 24)).unwrap();
    let cases: [(&str, &str, &str, u64, &str); 3] = [
        (
            "v2-1",
            "vault_01",
            "item_01",
            1,
            r#"{"id":"item_01","title":"v2 vector"}"#,
        ),
        (
            "v2-unicode-ids",
            "kho-bí-mật",
            "mục-✓-🔐",
            42,
            r#"{"id":"mục-✓-🔐","title":"unicode ids"}"#,
        ),
        (
            "v2-max-revision",
            "vault_01",
            "item_01",
            ITEM_AD_V2_MAX_REVISION,
            "",
        ),
    ];
    let vectors: Vec<Value> = cases
        .iter()
        .map(|&(id, vault_id, item_id, revision, plaintext)| {
            let binding = ItemBinding {
                vault_id,
                item_id,
                revision,
            };
            let payload_ad = item_ad_v2(ItemAdPurpose::Payload, &binding).unwrap();
            let wrap_ad = item_ad_v2(ItemAdPurpose::KeyWrap, &binding).unwrap();
            let payload_ct = aead::seal(
                plaintext.as_bytes(),
                Some(&payload_ad),
                &payload_nonce,
                &aead::Key(item_key),
            );
            let wrapped = aead::seal(
                &item_key,
                Some(&wrap_ad),
                &wrap_nonce,
                &aead::Key(vault_key),
            );
            json!({
                "id": id,
                "vault_id": vault_id,
                "item_id": item_id,
                "revision": revision,
                "plaintext": plaintext,
                "payload_ad_hex": hex::encode(&payload_ad),
                "payload_nonce_hex": hex::encode(payload_nonce),
                "payload_ciphertext_hex": hex::encode(&payload_ct),
                "key_wrap_ad_hex": hex::encode(&wrap_ad),
                "key_wrap_nonce_hex": hex::encode(wrap_nonce),
                "wrapped_item_key_hex": hex::encode(&wrapped),
            })
        })
        .collect();
    json!({
        "_comment": "Item encryption v2 known-answer vectors (XChaCha20-Poly1305 IETF with additional data). AD = u32be(len(label))||label || u32be(len(vault_id))||vault_id || u32be(len(item_id))||item_id || u64be(revision); labels below. *_ciphertext_hex / wrapped_item_key_hex are ciphertext||16-byte tag WITHOUT the nonce; the stored v2 blob is nonce(24)||that, exactly like v1. Asserted by native/crypto-core/tests/cross_impl.rs and packages/crypto-adapters/tests/cross-impl.test.ts.",
        "_generated": "cd native/crypto-core && cargo run --example gen_chain_vectors (deterministic: fixed keys and nonces; rerunning reproduces this file). NEVER hand-edit.",
        "labels": { "payload": ITEM_AD_V2_PAYLOAD_LABEL, "key_wrap": ITEM_AD_V2_KEY_WRAP_LABEL },
        "item_key_hex": hex::encode(item_key),
        "vault_key_hex": hex::encode(vault_key),
        "vectors": vectors,
    })
}

/// HKDF-SHA-256 with the TS adapter's fixed salt (32 zero bytes, which
/// HMAC treats exactly like an absent salt) — the only shape the TS
/// `hkdf(ikm, info, length)` can express.
fn hkdf_vectors() -> Value {
    let ikm = seq(0x0b, 32);
    let cases: [(&str, &str, usize); 3] = [
        ("hkdf-1", "my-secrect/item-key/v1", 32),
        ("hkdf-2-multiblock", "my-secrect/file-key/v1", 100),
        ("hkdf-3-empty-info", "", 42),
    ];
    let vectors: Vec<Value> = cases
        .iter()
        .map(|&(id, info, len)| {
            json!({
                "id": id,
                "info": info,
                "length": len,
                "okm_hex": hex::encode(hkdf_sha256(&ikm, Some(&[0u8; 32][..]), info.as_bytes(), len)),
            })
        })
        .collect();
    json!({
        "_comment": "HKDF-SHA-256 (RFC 5869), salt = 32 zero bytes, info = UTF-8. Computed by native/crypto-core::hkdf_sha256 (RustCrypto hkdf). Asserted against the TS adapter's hkdf AND node:crypto hkdfSync (OpenSSL) in packages/crypto-adapters/tests/cross-impl.test.ts, and against RFC 5869 test case 3 in native/crypto-core/tests/cross_impl.rs.",
        "_generated": "cd native/crypto-core && cargo run --example gen_chain_vectors (deterministic). NEVER hand-edit.",
        "ikm_hex": hex::encode(&ikm),
        "vectors": vectors,
    })
}

fn main() {
    init().expect("libsodium init");
    write_json("chain-rust.json", &chain_fixture());
    write_json("item-v2-vectors.json", &item_v2_vectors());
    write_json("hkdf-vectors.json", &hkdf_vectors());
}
