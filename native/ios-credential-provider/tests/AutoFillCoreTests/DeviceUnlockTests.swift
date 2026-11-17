import CryptoKit
import Foundation
import LocalAuthentication
import Security
import XCTest
@testable import AutoFillCore

/// Contract §4 blob layouts. The keychain / Secure Enclave lookups and the
/// biometric prompt need a device or simulator; the formats are checked here
/// with real CryptoKit and real Security.framework ECIES (software P-256 key).
final class DeviceUnlockTests: XCTestCase {
    func testKeychainAESGCMRoundTrip() throws {
        let amk = randomSecret(32)
        let deviceKey = randomSecret(32)
        let blob = try seal(amk, deviceKey)
        XCTAssertEqual(blob.count, 12 + 32 + 16, "nonce 12 ‖ ct ‖ tag 16")
        let opened = try DeviceUnlock.openKeychainAESGCM(wrappedAMK: blob, deviceKey: deviceKey)
        XCTAssertEqual(bytes(opened), bytes(amk))
    }

    func testKeychainAESGCMRejectsTamperWrongKeyAndBadSizes() throws {
        let amk = randomSecret(32)
        let deviceKey = randomSecret(32)
        var blob = try seal(amk, deviceKey)
        blob[20] ^= 0x01
        assertCorrupt { try DeviceUnlock.openKeychainAESGCM(wrappedAMK: blob, deviceKey: deviceKey) }
        assertCorrupt { try DeviceUnlock.openKeychainAESGCM(wrappedAMK: try self.seal(amk, deviceKey), deviceKey: randomSecret(32)) }
        assertCorrupt { try DeviceUnlock.openKeychainAESGCM(wrappedAMK: try self.seal(amk, deviceKey), deviceKey: randomSecret(16)) }
        assertCorrupt { try DeviceUnlock.openKeychainAESGCM(wrappedAMK: try self.seal(randomSecret(31), deviceKey), deviceKey: deviceKey) }
        assertCorrupt { try DeviceUnlock.openKeychainAESGCM(wrappedAMK: Data(count: 10), deviceKey: deviceKey) }
    }

    func testSecureEnclaveECIESFormatWithSoftwareKey() throws {
        let (privateKey, publicKey) = try softwareP256()
        let amk = randomSecret(32)
        let blob = try ecies(amk, publicKey)
        let opened = try DeviceUnlock.openSecureEnclaveECIES(wrappedAMK: blob, privateKey: privateKey)
        XCTAssertEqual(bytes(opened), bytes(amk))
    }

    func testSecureEnclaveECIESRejectsTamperAndWrongKey() throws {
        let (privateKey, publicKey) = try softwareP256()
        let (otherPrivate, _) = try softwareP256()
        var blob = try ecies(randomSecret(32), publicKey)
        assertCorrupt { try DeviceUnlock.openSecureEnclaveECIES(wrappedAMK: blob, privateKey: otherPrivate) }
        blob[blob.count - 1] ^= 0x01
        assertCorrupt { try DeviceUnlock.openSecureEnclaveECIES(wrappedAMK: blob, privateKey: privateKey) }
        assertCorrupt { try DeviceUnlock.openSecureEnclaveECIES(wrappedAMK: try self.ecies(randomSecret(16), publicKey), privateKey: privateKey) }
    }

    /// An unknown or other-platform scheme never reaches the keychain.
    func testUnknownSchemeIsCorrupt() {
        for scheme in ["android-ks-aesgcm-v1", "ios-se-p256-ecies-v2", ""] {
            let record = DeviceUnlockRecord(scheme: scheme, wrappedAMK: Data(count: 60))
            assertCorrupt { try DeviceUnlock.unwrapAccountMasterKey(record, accessGroup: "unused", context: LAContext()) }
        }
    }

    func testContractErrorCodes() {
        XCTAssertEqual(DeviceUnlock.map(status: errSecItemNotFound), .keyInvalidated)
        XCTAssertEqual(DeviceUnlock.map(status: errSecUserCanceled), .userCancel)
        XCTAssertEqual(DeviceUnlock.map(status: errSecAuthFailed), .authFailed)
        XCTAssertEqual(DeviceUnlock.map(status: errSecInteractionNotAllowed), .notAvailable)
        XCTAssertEqual(DeviceUnlock.map(laCode: .userCancel), .userCancel)
        XCTAssertEqual(DeviceUnlock.map(laCode: .userFallback), .userCancel)
        XCTAssertEqual(DeviceUnlock.map(laCode: .biometryNotEnrolled), .notEnrolled)
        XCTAssertEqual(DeviceUnlock.map(laCode: .biometryNotAvailable), .notAvailable)
        XCTAssertEqual(DeviceUnlock.map(laCode: .biometryLockout), .lockout)
        XCTAssertEqual(DeviceUnlock.map(laCode: .authenticationFailed), .authFailed)
        XCTAssertEqual(DeviceUnlock.map(laError: nil), .authFailed)
        XCTAssertEqual(DeviceUnlockError.keyInvalidated.rawValue, "KEY_INVALIDATED")
    }

    // MARK: - helpers

    private func seal(_ amk: SecretBytes, _ deviceKey: SecretBytes) throws -> Data {
        let key = deviceKey.withUnsafeBytes { SymmetricKey(data: $0) }
        return try XCTUnwrap(try amk.withUnsafeBytes { try AES.GCM.seal(Data($0), using: key) }.combined)
    }

    private func softwareP256() throws -> (SecKey, SecKey) {
        var error: Unmanaged<CFError>?
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
        ]
        let privateKey = try XCTUnwrap(SecKeyCreateRandomKey(attributes as CFDictionary, &error))
        return (privateKey, try XCTUnwrap(SecKeyCopyPublicKey(privateKey)))
    }

    private func ecies(_ amk: SecretBytes, _ publicKey: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        let data = amk.withUnsafeBytes { Data($0) }
        let sealed = SecKeyCreateEncryptedData(publicKey, .eciesEncryptionCofactorVariableIVX963SHA256AESGCM, data as CFData, &error)
        return try XCTUnwrap(sealed) as Data
    }

    private func assertCorrupt(_ body: () throws -> SecretBytes, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) {
            XCTAssertEqual($0 as? DeviceUnlockError, .corrupt, file: file, line: line)
        }
    }
}
