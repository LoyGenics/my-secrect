import Foundation
import Security
import SQLCipher

/// Read side of `vault.db` (specs/mobile-local-store.md §1–3).
///
/// SQLCipher 4 defaults, keyed with the 32-byte Local Storage Key as a raw
/// key (`PRAGMA key = "x'<64 hex>'"`). The provider opens the file
/// `query_only`: it never writes `rows` or `vault_keys` (contract §2).

/// One encrypted row — `rows` table, the StoredRow shape of apps/mobile/src/vault.ts.
public struct EncryptedVaultRow: Equatable {
    public let id: String
    public let revision: Int64
    public let nonce: String
    public let ciphertext: String
    public let wrappedItemKey: String
    public let wrappedNonce: String
    public let deletedAt: String?

    public init(id: String, revision: Int64, nonce: String, ciphertext: String,
                wrappedItemKey: String, wrappedNonce: String, deletedAt: String?) {
        self.id = id
        self.revision = revision
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.wrappedItemKey = wrappedItemKey
        self.wrappedNonce = wrappedNonce
        self.deletedAt = deletedAt
    }
}

/// One `autofill_index` row: titles, usernames and hosts only — no secrets.
public struct AutoFillIndexEntry: Equatable {
    public let id: String
    public let title: String
    public let username: String
    public let host: String
    public let type: String

    public init(id: String, title: String, username: String, host: String, type: String) {
        self.id = id
        self.title = title
        self.username = username
        self.host = host
        self.type = type
    }
}

/// The `device_unlock` row (contract §4). `wrappedAMK` is opaque per scheme.
public struct DeviceUnlockRecord: Equatable {
    public let scheme: String
    public let wrappedAMK: Data

    public init(scheme: String, wrappedAMK: Data) {
        self.scheme = scheme
        self.wrappedAMK = wrappedAMK
    }
}

public enum VaultDatabaseError: Error, Equatable {
    /// vault.db or the Local Storage Key does not exist (app not set up yet).
    case missing(String)
    /// Wrong LSK, or the file is not a SQLCipher database.
    case wrongKeyOrNotEncrypted
    /// The linked SQLite is not SQLCipher (`PRAGMA cipher_version` empty).
    case notSQLCipher
    case unsupportedSchema(String)
    case keychain(OSStatus)
    case sqlite(Int32, String)
    case corrupt(String)
}

public final class VaultDatabase {
    public static let appGroupID = "group.com.loygenics.my-secrect"
    public static let schemaVersion = "1"
    public static let localStorageKeyService = "com.loygenics.my-secrect.lsk"
    public static let localStorageKeyAccount = "v1"

    /// `<App Group>/Library/Application Support/my-secrect/`
    public static func directoryURL() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent("Library/Application Support/my-secrect", isDirectory: true)
    }

    public static func defaultURL() -> URL? {
        directoryURL()?.appendingPathComponent("vault.db", isDirectory: false)
    }

    /// Reads the LSK (contract §3: generic password, no biometric gate).
    public static func loadLocalStorageKey(accessGroup: String) throws -> SecretBytes {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: localStorageKeyService,
            kSecAttrAccount as String: localStorageKeyAccount,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else { throw VaultDatabaseError.missing("Local Storage Key") }
        guard status == errSecSuccess, let data = item as? Data else { throw VaultDatabaseError.keychain(status) }
        let key = SecretBytes(copying: data)
        guard key.count == 32 else { throw VaultDatabaseError.corrupt("Local Storage Key is not 32 bytes") }
        return key
    }

    let handle: OpaquePointer

    /// Opens an existing vault.db read-only (`query_only`) and checks the
    /// key, the SQLCipher build and the schema version.
    public init(url: URL, localStorageKey: SecretBytes) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw VaultDatabaseError.missing("vault.db") }
        let db = try Self.openKeyed(url: url, localStorageKey: localStorageKey, create: false)
        do {
            try Self.exec(db, "PRAGMA query_only = ON;")
            let version = try Self.scalarText(db, "SELECT value FROM meta WHERE key = 'schema_version';")
            guard version == Self.schemaVersion else {
                throw VaultDatabaseError.unsupportedSchema(version ?? "none")
            }
        } catch {
            sqlite3_close_v2(db)
            throw error
        }
        handle = db
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    public func autofillEntries() throws -> [AutoFillIndexEntry] {
        try Self.query(handle, "SELECT id, title, username, host, type FROM autofill_index ORDER BY title, id;") { stmt in
            AutoFillIndexEntry(
                id: try Self.text(stmt, 0), title: try Self.text(stmt, 1), username: try Self.text(stmt, 2),
                host: try Self.text(stmt, 3), type: try Self.text(stmt, 4)
            )
        }
    }

    public func autofillEntry(id: String) throws -> AutoFillIndexEntry? {
        try Self.query(handle, "SELECT id, title, username, host, type FROM autofill_index WHERE id = ?1;", bind: [id]) { stmt in
            AutoFillIndexEntry(
                id: try Self.text(stmt, 0), title: try Self.text(stmt, 1), username: try Self.text(stmt, 2),
                host: try Self.text(stmt, 3), type: try Self.text(stmt, 4)
            )
        }.first
    }

    /// nil when biometric unlock is not enrolled (no row).
    public func deviceUnlock() throws -> DeviceUnlockRecord? {
        try Self.query(handle, "SELECT scheme, wrapped_amk FROM device_unlock WHERE id = 1;") { stmt in
            guard let blob = Data(base64Encoded: try Self.text(stmt, 1)) else {
                throw VaultDatabaseError.corrupt("device_unlock.wrapped_amk is not base64")
            }
            return DeviceUnlockRecord(scheme: try Self.text(stmt, 0), wrappedAMK: blob)
        }.first
    }

    public func storedKeysJSON() throws -> String {
        guard let json = try Self.scalarText(handle, "SELECT json FROM vault_keys WHERE id = 1;") else {
            throw VaultDatabaseError.corrupt("vault_keys has no row")
        }
        return json
    }

    public func row(id: String) throws -> EncryptedVaultRow? {
        let sql = "SELECT id, revision, nonce, ciphertext, wrapped_item_key, wrapped_nonce, deleted_at FROM rows WHERE id = ?1;"
        return try Self.query(handle, sql, bind: [id]) { stmt in
            EncryptedVaultRow(
                id: try Self.text(stmt, 0),
                revision: sqlite3_column_int64(stmt, 1),
                nonce: try Self.text(stmt, 2),
                ciphertext: try Self.text(stmt, 3),
                wrappedItemKey: try Self.text(stmt, 4),
                wrappedNonce: try Self.text(stmt, 5),
                deletedAt: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : try Self.text(stmt, 6)
            )
        }.first
    }

    // MARK: - SQLite helpers (shared with the DEBUG writer)

    static func openKeyed(url: URL, localStorageKey: SecretBytes, create: Bool) throws -> OpaquePointer {
        guard localStorageKey.count == 32 else { throw VaultDatabaseError.corrupt("Local Storage Key is not 32 bytes") }
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | (create ? SQLITE_OPEN_CREATE : 0)
        let rc = sqlite3_open_v2(url.path, &db, flags, nil)
        guard rc == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close_v2(db)
            throw VaultDatabaseError.sqlite(rc, message)
        }
        do {
            try applyRawKey(db, localStorageKey)
            guard let cipher = try scalarText(db, "PRAGMA cipher_version;"), !cipher.isEmpty else {
                throw VaultDatabaseError.notSQLCipher
            }
            // First real read: fails with SQLITE_NOTADB on a wrong key or plaintext file.
            _ = try scalarText(db, "SELECT count(*) FROM sqlite_master;")
        } catch let VaultDatabaseError.sqlite(code, _) where code == SQLITE_NOTADB {
            sqlite3_close_v2(db)
            throw VaultDatabaseError.wrongKeyOrNotEncrypted
        } catch {
            sqlite3_close_v2(db)
            throw error
        }
        return db
    }

    /// `PRAGMA key = "x'<hex>'";` built in a wiped buffer, never a Swift String.
    static func applyRawKey(_ db: OpaquePointer, _ key: SecretBytes) throws {
        let prefix = Array("PRAGMA key = \"x'".utf8)
        let suffix = Array("'\";".utf8)
        let statement = SecretBytes(count: prefix.count + key.count * 2 + suffix.count + 1)
        defer { statement.wipe() }
        let hexDigits = Array("0123456789abcdef".utf8)
        statement.withUnsafeMutableBytes { out in
            var i = 0
            for b in prefix { out[i] = b; i += 1 }
            key.withUnsafeBytes { raw in
                for byte in raw {
                    out[i] = hexDigits[Int(byte >> 4)]
                    out[i + 1] = hexDigits[Int(byte & 0x0f)]
                    i += 2
                }
            }
            for b in suffix { out[i] = b; i += 1 }
            out[i] = 0
        }
        let rc = statement.withUnsafeBytes { buffer in
            sqlite3_exec(db, buffer.baseAddress!.assumingMemoryBound(to: CChar.self), nil, nil, nil)
        }
        guard rc == SQLITE_OK else { throw VaultDatabaseError.sqlite(rc, "PRAGMA key failed") }
    }

    static func exec(_ db: OpaquePointer, _ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &error)
        guard rc == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(db))
            sqlite3_free(error)
            throw VaultDatabaseError.sqlite(rc, message)
        }
    }

    static func scalarText(_ db: OpaquePointer, _ sql: String) throws -> String? {
        try query(db, sql) { stmt in
            sqlite3_column_type(stmt, 0) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 0))
        }.first ?? nil
    }

    static func text(_ stmt: OpaquePointer, _ column: Int32) throws -> String {
        guard let value = sqlite3_column_text(stmt, column) else {
            throw VaultDatabaseError.corrupt("NULL in a NOT NULL column")
        }
        return String(cString: value)
    }

    static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    static func bindValues(_ stmt: OpaquePointer, _ values: [Any?]) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let rc: Int32
            switch value {
            case nil:
                rc = sqlite3_bind_null(stmt, index)
            case let text as String:
                rc = sqlite3_bind_text(stmt, index, text, -1, transient)
            case let number as Int64:
                rc = sqlite3_bind_int64(stmt, index, number)
            case let number as Int:
                rc = sqlite3_bind_int64(stmt, index, Int64(number))
            default:
                throw VaultDatabaseError.corrupt("unsupported bind type")
            }
            guard rc == SQLITE_OK else { throw VaultDatabaseError.sqlite(rc, "bind failed") }
        }
    }

    static func query<T>(_ db: OpaquePointer, _ sql: String, bind: [Any?] = [], row: (OpaquePointer) throws -> T) throws -> [T] {
        var stmt: OpaquePointer?
        let prepared = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard prepared == SQLITE_OK, let stmt else {
            throw VaultDatabaseError.sqlite(prepared, String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        try bindValues(stmt, bind)
        var results: [T] = []
        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw VaultDatabaseError.sqlite(step, String(cString: sqlite3_errmsg(db))) }
            results.append(try row(stmt))
        }
        return results
    }
}
