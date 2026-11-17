//! The SQLCipher database key lives in the OS credential store, never on disk
//! next to the database.
//!
//! - macOS: login Keychain (generic password, service = app identifier,
//!   account = [`KEY_ACCOUNT`]), via the `keyring` crate.
//! - Windows: Credential Manager. Linux/BSD: Secret Service (GNOME Keyring /
//!   KWallet over D-Bus). Both compile but are NOT verified (see README.md).
//!
//! Policy, all fail-closed:
//! - key present            -> open the database with it;
//! - key absent, no database (or an empty file) -> generate a random key,
//!   store it, read it back, then create the database;
//! - key absent, database has data -> refuse. Creating a new key would make
//!   the existing vault unreadable, so the user must restore the keychain
//!   item (or move the old file away) — nothing is deleted;
//! - credential store unavailable / locked / access denied -> refuse.

use std::fs;
use std::path::Path;

use keyring::{Entry, Error as KeyringError};

use crate::store::{DbKey, KvStore, StoreError};

/// Keychain account name of the database key item.
pub const KEY_ACCOUNT: &str = "vault-db-key";
/// Database file name inside the data directory.
pub const DB_FILE: &str = "vault.db";

fn entry(service: &str) -> Result<Entry, StoreError> {
    Entry::new(service, KEY_ACCOUNT)
        .map_err(|e| StoreError::Key(format!("OS credential store unavailable: {e}")))
}

/// Read the key; `Ok(None)` only when the store answered "no such item".
pub fn read_key(service: &str) -> Result<Option<DbKey>, StoreError> {
    match entry(service)?.get_secret() {
        Ok(secret) => {
            let secret = zeroize::Zeroizing::new(secret);
            let bytes: [u8; 32] = secret.as_slice().try_into().map_err(|_| {
                StoreError::Key(format!(
                    "keychain item {service}/{KEY_ACCOUNT} is {} bytes, expected 32; refusing to use or replace it",
                    secret.len()
                ))
            })?;
            Ok(Some(DbKey::from_bytes(bytes)))
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(StoreError::Key(format!("could not read the database key from the OS credential store: {e}"))),
    }
}

fn store_new_key(service: &str) -> Result<DbKey, StoreError> {
    let key = DbKey::generate()?;
    entry(service)?
        .set_secret(key.as_bytes())
        .map_err(|e| StoreError::Key(format!("could not save the database key to the OS credential store: {e}")))?;
    // Read back: only a key the credential store really returns is used.
    match read_key(service)? {
        Some(stored) if stored.as_bytes() == key.as_bytes() => Ok(key),
        _ => Err(StoreError::Key(
            "the OS credential store did not return the key that was just saved".into(),
        )),
    }
}

fn database_has_data(path: &Path) -> Result<bool, StoreError> {
    match fs::metadata(path) {
        Ok(m) => Ok(m.len() > 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(StoreError::Io(format!("stat {}: {e}", path.display()))),
    }
}

/// Open (or create) `<data_dir>/vault.db` with the key held under `service`.
pub fn open_vault_store(data_dir: &Path, service: &str) -> Result<KvStore, StoreError> {
    create_private_dir(data_dir)?;
    let path = data_dir.join(DB_FILE);
    let key = match read_key(service)? {
        Some(key) => key,
        None if database_has_data(&path)? => {
            return Err(StoreError::Key(format!(
                "{} exists but its key ({service}/{KEY_ACCOUNT}) is missing from the OS credential store. \
                 Refusing to create a new key, which would make the existing vault unreadable. \
                 Restore the keychain item, or move vault.db away to start a new, empty vault.",
                path.display()
            )))
        }
        None => store_new_key(service)?,
    };
    KvStore::open(&path, &key)
}

fn create_private_dir(dir: &Path) -> Result<(), StoreError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|e| StoreError::Io(format!("create {}: {e}", dir.display())))
}

/// Remove the key item. Used by tests and the e2e harness for cleanup only;
/// the app never deletes its own key.
pub fn delete_key(service: &str) -> Result<(), StoreError> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(StoreError::Key(format!("could not delete keychain item: {e}"))),
    }
}

/// These tests touch the real OS credential store (login Keychain on
/// macOS) under a random, test-only service name and delete what they
/// create. Ignored by default because a locked or absent credential store
/// (CI, headless Linux) would prompt or fail; run with
/// `cargo test -- --ignored`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::KvOp;

    struct Fixture {
        service: String,
        dir: std::path::PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let mut n = [0u8; 8];
            getrandom::fill(&mut n).unwrap();
            let suffix: String = n.iter().map(|b| format!("{b:02x}")).collect();
            let dir = std::env::temp_dir().join(format!("my-secrect-keychain-{name}-{suffix}"));
            Fixture { service: format!("com.loygenics.my-secrect.test.{name}.{suffix}"), dir }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = delete_key(&self.service);
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    #[ignore = "touches the OS credential store"]
    fn creates_key_once_and_reuses_it() {
        let f = Fixture::new("reuse");
        assert!(read_key(&f.service).unwrap().is_none());
        {
            let mut s = open_vault_store(&f.dir, &f.service).unwrap();
            s.commit(0, &[KvOp::Set { key: "a".into(), value: "1".into() }]).unwrap();
        }
        let first = read_key(&f.service).unwrap().expect("key saved in keychain");
        let s = open_vault_store(&f.dir, &f.service).unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("1"));
        let second = read_key(&f.service).unwrap().unwrap();
        assert_eq!(first.as_bytes(), second.as_bytes(), "key must not be regenerated");
        // The key is not stored next to the database.
        for entry in fs::read_dir(&f.dir).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes.windows(32).any(|w| w == first.as_bytes()));
        }
    }

    #[test]
    #[ignore = "touches the OS credential store"]
    fn refuses_new_key_when_database_exists_without_key() {
        let f = Fixture::new("orphan");
        {
            let mut s = open_vault_store(&f.dir, &f.service).unwrap();
            s.commit(0, &[KvOp::Set { key: "a".into(), value: "1".into() }]).unwrap();
        }
        let db = f.dir.join(DB_FILE);
        let before = fs::read(&db).unwrap();
        delete_key(&f.service).unwrap();

        let err = open_vault_store(&f.dir, &f.service).err().expect("must fail closed");
        assert!(err.to_string().contains("Refusing to create a new key"), "{err}");
        assert!(read_key(&f.service).unwrap().is_none(), "no replacement key may be created");
        assert_eq!(fs::read(&db).unwrap(), before, "existing database must be left intact");
    }

    #[test]
    #[ignore = "touches the OS credential store"]
    fn rejects_malformed_key_item() {
        let f = Fixture::new("malformed");
        entry(&f.service).unwrap().set_secret(b"too short").unwrap();
        let err = open_vault_store(&f.dir, &f.service).err().expect("must fail closed");
        assert!(err.to_string().contains("expected 32"), "{err}");
        // The bad item is left for the user to inspect, not overwritten.
        assert_eq!(entry(&f.service).unwrap().get_secret().unwrap(), b"too short");
    }
}
