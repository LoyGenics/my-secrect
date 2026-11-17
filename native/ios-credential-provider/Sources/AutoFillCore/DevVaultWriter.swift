#if DEBUG
import Foundation
import SQLCipher

/// DEBUG builds only — compiled out of Release. Writes a `vault.db` in the
/// contract layout (specs/mobile-local-store.md §2) for the unit tests. The
/// app owns the real write path; the provider never creates tables.
public enum DevVaultWriter {
    /// Contract §2 DDL, verbatim.
    public static let schemaSQL = """
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_keys (
      id   INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rows (
      id               TEXT PRIMARY KEY,
      revision         INTEGER NOT NULL,
      nonce            TEXT NOT NULL,
      ciphertext       TEXT NOT NULL,
      wrapped_item_key TEXT NOT NULL,
      wrapped_nonce    TEXT NOT NULL,
      deleted_at       TEXT
    );
    CREATE TABLE IF NOT EXISTS device_unlock (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      scheme       TEXT NOT NULL,
      wrapped_amk  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autofill_index (
      id       TEXT PRIMARY KEY,
      title    TEXT NOT NULL,
      username TEXT NOT NULL,
      host     TEXT NOT NULL,
      type     TEXT NOT NULL
    );
    """

    public struct Contents {
        public var schemaVersion = VaultDatabase.schemaVersion
        public var storedKeysJSON: String?
        public var rows: [EncryptedVaultRow] = []
        public var autofillIndex: [AutoFillIndexEntry] = []
        public var deviceUnlock: DeviceUnlockRecord?

        public init() {}
    }

    /// Creates (or adds to) the database at `url`, keyed with `localStorageKey`.
    public static func write(_ contents: Contents, to url: URL, localStorageKey: SecretBytes) throws {
        let db = try VaultDatabase.openKeyed(url: url, localStorageKey: localStorageKey, create: true)
        defer { sqlite3_close_v2(db) }
        try VaultDatabase.exec(db, "PRAGMA journal_mode = WAL;")
        try VaultDatabase.exec(db, schemaSQL)
        try VaultDatabase.exec(db, "BEGIN IMMEDIATE;")
        do {
            try insert(db, "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1);", [contents.schemaVersion])
            if let json = contents.storedKeysJSON {
                try insert(db, "INSERT OR REPLACE INTO vault_keys (id, json) VALUES (1, ?1);", [json])
            }
            for row in contents.rows {
                try insert(db, """
                INSERT OR REPLACE INTO rows (id, revision, nonce, ciphertext, wrapped_item_key, wrapped_nonce, deleted_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
                """, [row.id, row.revision, row.nonce, row.ciphertext, row.wrappedItemKey, row.wrappedNonce, row.deletedAt])
            }
            for entry in contents.autofillIndex {
                try insert(db, "INSERT OR REPLACE INTO autofill_index (id, title, username, host, type) VALUES (?1, ?2, ?3, ?4, ?5);",
                           [entry.id, entry.title, entry.username, entry.host, entry.type])
            }
            if let unlock = contents.deviceUnlock {
                try insert(db, "INSERT OR REPLACE INTO device_unlock (id, scheme, wrapped_amk, created_at) VALUES (1, ?1, ?2, ?3);",
                           [unlock.scheme, unlock.wrappedAMK.base64EncodedString(), ISO8601DateFormatter().string(from: Date())])
            }
            try VaultDatabase.exec(db, "COMMIT;")
        } catch {
            try? VaultDatabase.exec(db, "ROLLBACK;")
            throw error
        }
    }

    private static func insert(_ db: OpaquePointer, _ sql: String, _ values: [Any?]) throws {
        _ = try VaultDatabase.query(db, sql, bind: values) { _ in () }
    }
}
#endif
