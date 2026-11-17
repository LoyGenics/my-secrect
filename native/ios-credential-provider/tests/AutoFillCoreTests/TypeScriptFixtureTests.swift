import Foundation
import XCTest
@testable import AutoFillCore

/// Decrypts rows the real TypeScript crypto wrote (generate-fixtures.ts,
/// same calls as apps/mobile/src/vault.ts).
final class TypeScriptFixtureTests: XCTestCase {
    var fixture: TSFixture!

    override func setUpWithError() throws {
        fixture = try TSFixture.load()
    }

    /// passphrase → Argon2id KEK → AMK, exactly as unlockVault() does.
    func testPassphraseUnwrapsTheFixtureMasterKey() throws {
        struct Keys: Decodable { let salt, wrapped_master, wrapped_master_nonce: String }
        let keys = try JSONDecoder().decode(Keys.self, from: Data(fixture.stored_keys_json.utf8))
        let kek = argon2idKEK(passphrase: fixture.passphrase, salt: Array(Data(base64Encoded: keys.salt)!))
        let master = try XChaCha20Poly1305.unwrapKey(
            wrappingKey: kek,
            nonce: Data(base64Encoded: keys.wrapped_master_nonce)!,
            wrapped: Data(base64Encoded: keys.wrapped_master)!,
            layer: "master key"
        )
        XCTAssertEqual(bytes(master), bytes(fixture.accountMasterKey))
    }

    func testEveryExpectedLoginDecrypts() throws {
        XCTAssertEqual(fixture.expected_logins.count, 2)
        for expected in fixture.expected_logins {
            let login = try CredentialFill.decryptLogin(
                row: fixture.row(expected.id), storedKeysJSON: fixture.stored_keys_json,
                accountMasterKey: fixture.accountMasterKey, pageHost: fixture.host(expected.id)
            )
            XCTAssertEqual(login.username, expected.username)
            XCTAssertEqual(login.password, expected.password)
        }
    }

    func testSubdomainPageMatchesItemURL() throws {
        let login = try CredentialFill.decryptLogin(
            row: fixture.row("item_af_login_1"), storedKeysJSON: fixture.stored_keys_json,
            accountMasterKey: fixture.accountMasterKey, pageHost: "accounts.example.com"
        )
        XCTAssertEqual(login.username, "fixture-user@example.com")
    }

    func testOtherSiteIsRefusedByTheDecryptedURL() {
        assertFill("item_af_login_1", pageHost: "example.net", throws: FillError.domainMismatch)
        assertFill("item_af_login_1", pageHost: "notexample.com", throws: FillError.domainMismatch)
    }

    func testTrashedRowIsNotFilled() {
        assertFill("item_af_trashed", pageHost: "example.com", throws: FillError.itemNotFound)
    }

    func testNonLoginsAndMissingPasswordAreRefused() {
        assertFill("item_af_note", pageHost: "example.com", throws: FillError.notALogin)
        assertFill("item_af_passkey", pageHost: "example.com", throws: FillError.notALogin)
        assertFill("item_af_login_nopw", pageHost: "nopw.example.org", throws: FillError.notALogin)
    }

    func testWrongMasterKeyFailsAtTheVaultKey() {
        XCTAssertThrowsError(try CredentialFill.decryptLogin(
            row: fixture.row("item_af_login_1"), storedKeysJSON: fixture.stored_keys_json,
            accountMasterKey: randomSecret(32), pageHost: "example.com"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .authenticationFailed("vault key")) }
    }

    func testTamperedCiphertextIsRejected() {
        let row = fixture.row("item_af_login_1")
        let tampered = EncryptedVaultRow(id: row.id, revision: row.revision, nonce: row.nonce,
                                         ciphertext: flipBit(row.ciphertext, at: 10),
                                         wrappedItemKey: row.wrappedItemKey, wrappedNonce: row.wrappedNonce, deletedAt: nil)
        assertFill(tampered, throws: VaultCryptoError.authenticationFailed("item"))
    }

    func testTamperedNonceIsRejected() {
        let row = fixture.row("item_af_login_1")
        let tampered = EncryptedVaultRow(id: row.id, revision: row.revision, nonce: flipBit(row.nonce),
                                         ciphertext: row.ciphertext,
                                         wrappedItemKey: row.wrappedItemKey, wrappedNonce: row.wrappedNonce, deletedAt: nil)
        assertFill(tampered, throws: VaultCryptoError.authenticationFailed("item"))
    }

    func testTamperedWrappedItemKeyIsRejected() {
        let row = fixture.row("item_af_login_1")
        let tampered = EncryptedVaultRow(id: row.id, revision: row.revision, nonce: row.nonce, ciphertext: row.ciphertext,
                                         wrappedItemKey: flipBit(row.wrappedItemKey, at: 3),
                                         wrappedNonce: row.wrappedNonce, deletedAt: nil)
        assertFill(tampered, throws: VaultCryptoError.authenticationFailed("item key"))
    }

    /// Another row's ciphertext under this id decrypts, but its id gives it away.
    func testRowSwapIsRejected() {
        let other = fixture.row("item_af_login_2")
        let swapped = EncryptedVaultRow(id: "item_af_login_1", revision: 1, nonce: other.nonce, ciphertext: other.ciphertext,
                                        wrappedItemKey: other.wrappedItemKey, wrappedNonce: other.wrappedNonce, deletedAt: nil)
        assertFill(swapped, pageHost: "the-internet.herokuapp.com",
                   throws: FillError.invalidItem("decrypted item id does not match the row id"))
    }

    func testTamperedStoredKeysAreRejected() throws {
        var keys = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture.stored_keys_json.utf8)) as? [String: String])
        keys["wrapped_vault"] = flipBit(try XCTUnwrap(keys["wrapped_vault"]), at: 5)
        let tampered = String(decoding: try JSONSerialization.data(withJSONObject: keys), as: UTF8.self)
        XCTAssertThrowsError(try CredentialFill.decryptLogin(
            row: fixture.row("item_af_login_1"), storedKeysJSON: tampered,
            accountMasterKey: fixture.accountMasterKey, pageHost: "example.com"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .authenticationFailed("vault key")) }
        XCTAssertThrowsError(try CredentialFill.decryptLogin(
            row: fixture.row("item_af_login_1"), storedKeysJSON: "{}",
            accountMasterKey: fixture.accountMasterKey, pageHost: "example.com"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .malformed("vault_keys JSON")) }
    }

    // MARK: - helpers

    private func assertFill<E: Error & Equatable>(_ id: String, pageHost: String, throws expected: E,
                                                  file: StaticString = #filePath, line: UInt = #line) {
        assertFill(fixture.row(id), pageHost: pageHost, throws: expected, file: file, line: line)
    }

    private func assertFill<E: Error & Equatable>(_ row: EncryptedVaultRow, pageHost: String = "example.com", throws expected: E,
                                                  file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try CredentialFill.decryptLogin(
            row: row, storedKeysJSON: fixture.stored_keys_json,
            accountMasterKey: fixture.accountMasterKey, pageHost: pageHost
        ), file: file, line: line) { error in
            XCTAssertEqual(error as? E, expected, "\(error)", file: file, line: line)
        }
    }
}
