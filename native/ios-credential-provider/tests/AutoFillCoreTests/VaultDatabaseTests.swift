import AuthenticationServices
import CryptoKit
import Foundation
import SQLCipher
import XCTest
@testable import AutoFillCore

/// vault.db per specs/mobile-local-store.md §2 (SQLCipher 4, raw LSK key),
/// filled with the TypeScript fixture rows.
final class VaultDatabaseTests: XCTestCase {
    var fixture: TSFixture!
    var directory: URL!
    var dbURL: URL { directory.appendingPathComponent("vault.db") }

    override func setUpWithError() throws {
        fixture = try TSFixture.load()
        directory = try temporaryDirectory()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Contract §6 without the biometric prompt: index → device_unlock →
    /// `ios-kc-aesgcm-v1` blob → AMK → Vault Key → Item Key → one row.
    func testFullProviderPathOverSQLCipher() throws {
        let lsk = randomSecret(32)
        let deviceKey = randomSecret(32)
        var contents = fixture.contents
        contents.deviceUnlock = DeviceUnlockRecord(scheme: DeviceUnlockScheme.keychainAESGCM.rawValue,
                                                   wrappedAMK: try sealAMK(fixture.accountMasterKey, with: deviceKey))
        try DevVaultWriter.write(contents, to: dbURL, localStorageKey: lsk)

        let db = try VaultDatabase(url: dbURL, localStorageKey: lsk)
        let entries = try db.autofillEntries()
        XCTAssertEqual(Set(entries.map(\.id)), Set(fixture.autofill_index.map(\.id)))

        let service = ASCredentialServiceIdentifier(identifier: "https://the-internet.herokuapp.com/login", type: .URL)
        let candidates = AutoFillMatcher.candidates(entries: entries, serviceIdentifiers: [service])
        XCTAssertEqual(candidates.map(\.entry.id), ["item_af_login_2"])

        let unlock = try XCTUnwrap(try db.deviceUnlock())
        XCTAssertEqual(unlock.scheme, "ios-kc-aesgcm-v1")
        let amk = try DeviceUnlock.openKeychainAESGCM(wrappedAMK: unlock.wrappedAMK, deviceKey: deviceKey)
        let row = try XCTUnwrap(try db.row(id: candidates[0].entry.id))
        XCTAssertEqual(row, fixture.row("item_af_login_2"))
        let login = try CredentialFill.decryptLogin(row: row, storedKeysJSON: try db.storedKeysJSON(),
                                                    accountMasterKey: amk, pageHost: "the-internet.herokuapp.com")
        XCTAssertEqual(login.username, "tomsmith")
        XCTAssertEqual(login.password, "SuperSecretPassword!")
    }

    func testFileIsEncryptedOnDisk() throws {
        try DevVaultWriter.write(fixture.contents, to: dbURL, localStorageKey: randomSecret(32))
        let header = try Data(contentsOf: dbURL).prefix(16)
        XCTAssertNotEqual(header, Data("SQLite format 3\0".utf8))
        let raw = try Data(contentsOf: dbURL)
        XCTAssertNil(raw.range(of: Data("fixture-user@example.com".utf8)), "index usernames must not be readable without the LSK")
    }

    func testWrongLocalStorageKeyIsRejected() throws {
        try DevVaultWriter.write(fixture.contents, to: dbURL, localStorageKey: randomSecret(32))
        XCTAssertThrowsError(try VaultDatabase(url: dbURL, localStorageKey: randomSecret(32))) {
            XCTAssertEqual($0 as? VaultDatabaseError, .wrongKeyOrNotEncrypted)
        }
    }

    func testPlaintextSQLiteIsRejected() throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, DevVaultWriter.schemaSQL + "INSERT INTO meta VALUES ('schema_version','1');", nil, nil, nil), SQLITE_OK)
        sqlite3_close_v2(db)
        XCTAssertThrowsError(try VaultDatabase(url: dbURL, localStorageKey: randomSecret(32))) {
            XCTAssertEqual($0 as? VaultDatabaseError, .wrongKeyOrNotEncrypted)
        }
    }

    func testMissingDatabaseIsReportedNotCreated() {
        XCTAssertThrowsError(try VaultDatabase(url: dbURL, localStorageKey: randomSecret(32))) {
            XCTAssertEqual($0 as? VaultDatabaseError, .missing("vault.db"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dbURL.path))
    }

    func testMissingDeviceUnlockRowReadsAsNil() throws {
        let lsk = randomSecret(32)
        try DevVaultWriter.write(fixture.contents, to: dbURL, localStorageKey: lsk)
        XCTAssertNil(try VaultDatabase(url: dbURL, localStorageKey: lsk).deviceUnlock())
    }

    func testUnknownSchemaVersionIsRejected() throws {
        let lsk = randomSecret(32)
        var contents = fixture.contents
        contents.schemaVersion = "2"
        try DevVaultWriter.write(contents, to: dbURL, localStorageKey: lsk)
        XCTAssertThrowsError(try VaultDatabase(url: dbURL, localStorageKey: lsk)) {
            XCTAssertEqual($0 as? VaultDatabaseError, .unsupportedSchema("2"))
        }
    }

    func testMissingRowAndCorruptDeviceUnlock() throws {
        let lsk = randomSecret(32)
        try DevVaultWriter.write(fixture.contents, to: dbURL, localStorageKey: lsk)
        // Simulate a damaged device_unlock blob written by something else.
        let writer = try VaultDatabase.openKeyed(url: dbURL, localStorageKey: lsk, create: false)
        try VaultDatabase.exec(writer, "INSERT INTO device_unlock VALUES (1, 'ios-kc-aesgcm-v1', '***not base64***', 'now');")
        sqlite3_close_v2(writer)

        let db = try VaultDatabase(url: dbURL, localStorageKey: lsk)
        XCTAssertNil(try db.row(id: "item_does_not_exist"))
        XCTAssertNil(try db.autofillEntry(id: "item_does_not_exist"))
        XCTAssertThrowsError(try db.deviceUnlock()) {
            XCTAssertEqual($0 as? VaultDatabaseError, .corrupt("device_unlock.wrapped_amk is not base64"))
        }
    }

    /// The provider connection is query_only: it cannot write rows or keys.
    func testProviderConnectionCannotWrite() throws {
        let lsk = randomSecret(32)
        try DevVaultWriter.write(fixture.contents, to: dbURL, localStorageKey: lsk)
        let db = try VaultDatabase(url: dbURL, localStorageKey: lsk)
        XCTAssertThrowsError(try VaultDatabase.exec(db.handle, "DELETE FROM rows;"))
        XCTAssertThrowsError(try VaultDatabase.exec(db.handle, "UPDATE vault_keys SET json = '{}';"))
        XCTAssertEqual(try db.storedKeysJSON(), fixture.stored_keys_json)
    }

    private func sealAMK(_ amk: SecretBytes, with deviceKey: SecretBytes) throws -> Data {
        let key = deviceKey.withUnsafeBytes { SymmetricKey(data: $0) }
        return try XCTUnwrap(try amk.withUnsafeBytes { try AES.GCM.seal(Data($0), using: key) }.combined)
    }
}
