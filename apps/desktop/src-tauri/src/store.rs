//! Encrypted key/value store on SQLCipher.
//!
//! One database file (`vault.db`) holds the same string key/value pairs the
//! frontend `StorageBackend` used to keep in localStorage (encrypted vault
//! rows + wrapped keys, already ciphertext). SQLCipher adds whole-file
//! encryption at rest, so metadata (item count, revisions, sizes, key names)
//! is no longer readable on disk either, and writes become transactional.
//!
//! The 32-byte database key is supplied by the caller (see `keychain.rs`);
//! this module never generates, prints or persists it.
//!
//! Writes go through [`KvStore::commit`]: a batch of set/remove operations
//! applied in ONE transaction, guarded by a generation counter (compare and
//! swap) so a stale writer — a second window, a reloaded page, a second app
//! instance — is rejected instead of silently overwriting newer data.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Schema version written to `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 1;
/// Longest key accepted (bytes). Enforced by a CHECK constraint, so a bad
/// key fails inside the transaction and rolls the whole batch back.
pub const MAX_KEY_LEN: usize = 512;

/// A 256-bit SQLCipher raw key. Zeroed on drop; never `Debug`/`Display`.
pub struct DbKey(Zeroizing<[u8; 32]>);

impl DbKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        DbKey(Zeroizing::new(bytes))
    }

    /// Fresh random key from the OS CSPRNG.
    pub fn generate() -> Result<Self, StoreError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut())
            .map_err(|e| StoreError::Key(format!("OS random generator failed: {e}")))?;
        Ok(DbKey(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// SQLCipher raw-key literal `x'<64 hex>'` (bypasses the passphrase KDF:
    /// the key is already uniformly random). Zeroed on drop.
    fn raw_key_literal(&self) -> Zeroizing<Vec<u8>> {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = Zeroizing::new(Vec::with_capacity(67));
        out.extend_from_slice(b"x'");
        for b in self.0.iter() {
            out.push(HEX[(b >> 4) as usize]);
            out.push(HEX[(b & 0x0f) as usize]);
        }
        out.push(b'\'');
        out
    }
}

#[derive(Debug)]
pub enum StoreError {
    /// The key could not be obtained or does not open the database.
    Key(String),
    /// Wrong key, or the file is not a (SQLCipher) database.
    WrongKeyOrCorrupt,
    /// The file was written by a newer schema than this build understands.
    UnsupportedSchema(i64),
    /// Compare-and-swap failure: the store changed since the caller's snapshot.
    StaleGeneration { expected: u64, actual: u64 },
    Io(String),
    Sqlite(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Key(m) => write!(f, "vault database key unavailable: {m}"),
            StoreError::WrongKeyOrCorrupt => write!(
                f,
                "vault.db could not be opened with the key from the OS credential store \
                 (wrong key or corrupted file); nothing was changed"
            ),
            StoreError::UnsupportedSchema(v) => write!(
                f,
                "vault.db uses schema version {v}, newer than this app supports ({SCHEMA_VERSION}); \
                 update the app — nothing was changed"
            ),
            StoreError::StaleGeneration { expected, actual } => write!(
                f,
                "write rejected: the vault changed elsewhere (expected generation {expected}, \
                 store is at {actual}); restart the app to load the current vault"
            ),
            StoreError::Io(m) => write!(f, "vault storage I/O error: {m}"),
            StoreError::Sqlite(m) => write!(f, "vault database error: {m}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        if e.sqlite_error_code() == Some(ErrorCode::NotADatabase) {
            StoreError::WrongKeyOrCorrupt
        } else {
            StoreError::Sqlite(e.to_string())
        }
    }
}

/// One write in a batch. JSON shape: `{"op":"set","key":..,"value":..}` or
/// `{"op":"remove","key":..}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum KvOp {
    Set { key: String, value: String },
    Remove { key: String },
}

/// Every stored pair plus the generation it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub generation: u64,
    pub entries: BTreeMap<String, String>,
}

pub struct KvStore {
    conn: Connection,
}

impl KvStore {
    /// Open `path` with `key`, creating the database (mode 0600 on Unix) if
    /// it does not exist. A wrong key fails with
    /// [`StoreError::WrongKeyOrCorrupt`] and leaves the file untouched.
    pub fn open(path: &Path, key: &DbKey) -> Result<Self, StoreError> {
        create_private_file_if_missing(path)?;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )?;
        apply_key(&conn, key)?;
        // First real read: fails with SQLITE_NOTADB if the key is wrong.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = KvStore { conn };
        store.migrate_schema()?;
        Ok(store)
    }

    fn migrate_schema(&mut self) -> Result<(), StoreError> {
        let version: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::UnsupportedSchema(version));
        }
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        // version 0: empty file -> create schema v1 atomically.
        let tx = self.conn.transaction()?;
        tx.execute_batch(&format!(
            "CREATE TABLE kv (
                key   TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(key AS BLOB)) BETWEEN 1 AND {MAX_KEY_LEN}),
                value TEXT NOT NULL
             ) WITHOUT ROWID;
             CREATE TABLE meta (
                name  TEXT PRIMARY KEY NOT NULL,
                value INTEGER NOT NULL
             ) WITHOUT ROWID;
             INSERT INTO meta (name, value) VALUES ('generation', 0);
             PRAGMA user_version = {SCHEMA_VERSION};"
        ))?;
        tx.commit()?;
        Ok(())
    }

    pub fn generation(&self) -> Result<u64, StoreError> {
        let g: i64 = self
            .conn
            .query_row("SELECT value FROM meta WHERE name = 'generation'", [], |r| r.get(0))?;
        Ok(g as u64)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    /// All pairs and the generation, read in one transaction.
    pub fn snapshot(&mut self) -> Result<Snapshot, StoreError> {
        let tx = self.conn.transaction()?;
        let generation: i64 =
            tx.query_row("SELECT value FROM meta WHERE name = 'generation'", [], |r| r.get(0))?;
        let mut entries = BTreeMap::new();
        {
            let mut stmt = tx.prepare("SELECT key, value FROM kv")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (k, v) = row?;
                entries.insert(k, v);
            }
        }
        tx.commit()?;
        Ok(Snapshot { generation: generation as u64, entries })
    }

    /// Apply `ops` in order, in one transaction, if and only if the store is
    /// still at `expected_generation`. Returns the new generation. Any
    /// failure (stale generation, constraint violation, I/O) rolls back the
    /// whole batch: either every op is applied or none is.
    pub fn commit(&mut self, expected_generation: u64, ops: &[KvOp]) -> Result<u64, StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let actual: i64 =
            tx.query_row("SELECT value FROM meta WHERE name = 'generation'", [], |r| r.get(0))?;
        let actual = actual as u64;
        if actual != expected_generation {
            return Err(StoreError::StaleGeneration { expected: expected_generation, actual });
        }
        {
            let mut set = tx.prepare(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?;
            let mut remove = tx.prepare("DELETE FROM kv WHERE key = ?1")?;
            for op in ops {
                match op {
                    KvOp::Set { key, value } => {
                        set.execute(params![key, value])?;
                    }
                    KvOp::Remove { key } => {
                        remove.execute([key])?;
                    }
                }
            }
        }
        let next = actual + 1;
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE name = 'generation'",
            [next as i64],
        )?;
        tx.commit()?;
        Ok(next)
    }
}

/// Set the SQLCipher key through `sqlite3_key_v2` so the key material only
/// lives in a zeroizing buffer here (a `PRAGMA key` string would leave
/// copies in statement buffers).
fn apply_key(conn: &Connection, key: &DbKey) -> Result<(), StoreError> {
    let literal = key.raw_key_literal();
    // SAFETY: `conn.handle()` is a valid open database for the lifetime of
    // `conn`; the key pointer/length describe `literal`, which outlives the
    // call; SQLCipher copies the key into its own (zeroed-on-free) memory.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_key_v2(
            conn.handle(),
            c"main".as_ptr(),
            literal.as_ptr().cast(),
            literal.len() as std::os::raw::c_int,
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err(StoreError::Key(format!("sqlite3_key_v2 failed with code {rc}")));
    }
    Ok(())
}

fn create_private_file_if_missing(path: &Path) -> Result<(), StoreError> {
    if path.exists() {
        return Ok(());
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(StoreError::Io(format!("create {}: {e}", path.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "my-secrect-store-{name}-{}",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn key(byte: u8) -> DbKey {
        DbKey::from_bytes([byte; 32])
    }

    fn set(k: &str, v: &str) -> KvOp {
        KvOp::Set { key: k.into(), value: v.into() }
    }

    #[test]
    fn opens_with_its_key_and_persists_across_reopen() {
        let dir = temp_dir("reopen");
        let path = dir.join("vault.db");
        {
            let mut s = KvStore::open(&path, &key(7)).unwrap();
            assert_eq!(s.generation().unwrap(), 0);
            let g = s.commit(0, &[set("a", "1"), set("b", "2")]).unwrap();
            assert_eq!(g, 1);
        }
        let mut s = KvStore::open(&path, &key(7)).unwrap();
        let snap = s.snapshot().unwrap();
        assert_eq!(snap.generation, 1);
        assert_eq!(snap.entries.get("a").map(String::as_str), Some("1"));
        assert_eq!(snap.entries.get("b").map(String::as_str), Some("2"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn wrong_key_fails_and_leaves_file_untouched() {
        let dir = temp_dir("wrongkey");
        let path = dir.join("vault.db");
        {
            let mut s = KvStore::open(&path, &key(1)).unwrap();
            s.commit(0, &[set("k", "v")]).unwrap();
        }
        let before = fs::read(&path).unwrap();
        match KvStore::open(&path, &key(2)) {
            Err(StoreError::WrongKeyOrCorrupt) => {}
            Err(e) => panic!("expected WrongKeyOrCorrupt, got {e}"),
            Ok(_) => panic!("wrong key opened the database"),
        }
        assert_eq!(fs::read(&path).unwrap(), before, "a failed open must not modify the file");
        // The right key still works afterwards.
        let s = KvStore::open(&path, &key(1)).unwrap();
        assert_eq!(s.get("k").unwrap().as_deref(), Some("v"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_on_disk_is_encrypted() {
        let dir = temp_dir("ciphertext");
        let path = dir.join("vault.db");
        let marker = "PLAINTEXT-MARKER-my-secrect.local-vault.v1";
        {
            let mut s = KvStore::open(&path, &key(3)).unwrap();
            s.commit(0, &[set(marker, marker)]).unwrap();
        }
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.len() >= 4096);
        assert_ne!(&bytes[..16], b"SQLite format 3\0", "header must not be plain SQLite");
        assert!(
            !bytes.windows(marker.len()).any(|w| w == marker.as_bytes()),
            "stored key/value text must not appear in the file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn batch_is_atomic_when_an_op_fails_midway() {
        let dir = temp_dir("atomic");
        let path = dir.join("vault.db");
        let mut s = KvStore::open(&path, &key(4)).unwrap();
        s.commit(0, &[set("keep", "old")]).unwrap();

        // Op 1 and 2 succeed inside the transaction, op 3 violates the key
        // CHECK constraint, op 4 never runs: nothing may be visible.
        let too_long = "k".repeat(MAX_KEY_LEN + 1);
        let err = s
            .commit(
                1,
                &[
                    set("keep", "new"),
                    set("added", "x"),
                    set(&too_long, "boom"),
                    KvOp::Remove { key: "keep".into() },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Sqlite(_)), "unexpected error: {err}");

        let snap = s.snapshot().unwrap();
        assert_eq!(snap.generation, 1, "failed batch must not bump the generation");
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.entries.get("keep").map(String::as_str), Some("old"));

        // Same result after reopening from disk.
        drop(s);
        let mut s = KvStore::open(&path, &key(4)).unwrap();
        assert_eq!(s.snapshot().unwrap(), snap);

        // Empty key is rejected by the same constraint.
        assert!(s.commit(1, &[set("", "v")]).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_generation_is_rejected_without_writing() {
        let dir = temp_dir("cas");
        let path = dir.join("vault.db");
        let mut s = KvStore::open(&path, &key(5)).unwrap();
        assert_eq!(s.commit(0, &[set("a", "1")]).unwrap(), 1);
        assert_eq!(s.commit(1, &[set("a", "2")]).unwrap(), 2);
        // A writer still at generation 1 (stale snapshot) must not win.
        match s.commit(1, &[set("a", "stale")]) {
            Err(StoreError::StaleGeneration { expected: 1, actual: 2 }) => {}
            other => panic!("expected StaleGeneration, got {other:?}"),
        }
        assert_eq!(s.get("a").unwrap().as_deref(), Some("2"));
        assert_eq!(s.generation().unwrap(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_localstorage_import_round_trips_in_one_batch() {
        // Migration shape: the two localStorage vault keys, copied verbatim
        // in one batch, then read back for verification before the
        // frontend deletes the localStorage copy.
        let dir = temp_dir("migrate");
        let path = dir.join("vault.db");
        let rows = format!(
            "[{{\"id\":\"ü-ñ-漢字-🔐\",\"revision\":3,\"nonce\":\"{}\",\"ciphertext\":\"{}\"}}]",
            "A".repeat(32),
            "B".repeat(200_000)
        );
        let keys = r#"{"salt":"c2FsdA==","wrapped_master":"bQ=="}"#;
        let legacy = [
            ("my-secrect.local-vault.v1", rows.as_str()),
            ("my-secrect.local-vault.v1.keys", keys),
        ];
        {
            let mut s = KvStore::open(&path, &key(6)).unwrap();
            let ops: Vec<KvOp> = legacy.iter().map(|(k, v)| set(k, v)).collect();
            assert_eq!(s.commit(0, &ops).unwrap(), 1);
        }
        let mut s = KvStore::open(&path, &key(6)).unwrap();
        let snap = s.snapshot().unwrap();
        for (k, v) in legacy {
            assert_eq!(snap.entries.get(k).map(String::as_str), Some(v), "{k} not copied verbatim");
        }
        // Removing keys is also a batch op.
        assert_eq!(
            s.commit(1, &[KvOp::Remove { key: "my-secrect.local-vault.v1".into() }]).unwrap(),
            2
        );
        assert_eq!(s.get("my-secrect.local-vault.v1").unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn newer_schema_version_fails_closed() {
        let dir = temp_dir("schema");
        let path = dir.join("vault.db");
        {
            let s = KvStore::open(&path, &key(8)).unwrap();
            s.conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        }
        match KvStore::open(&path, &key(8)) {
            Err(StoreError::UnsupportedSchema(99)) => {}
            Err(e) => panic!("expected UnsupportedSchema, got {e}"),
            Ok(_) => panic!("opened a database with a newer schema"),
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn op_json_shape_matches_frontend() {
        let ops: Vec<KvOp> = serde_json::from_str(
            r#"[{"op":"set","key":"a","value":"1"},{"op":"remove","key":"b"}]"#,
        )
        .unwrap();
        assert_eq!(ops, vec![set("a", "1"), KvOp::Remove { key: "b".into() }]);
        assert!(serde_json::from_str::<KvOp>(r#"{"op":"drop","key":"a"}"#).is_err());
    }
}
