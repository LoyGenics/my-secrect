#if DEBUG && targetEnvironment(simulator)
import CryptoKit
import Foundation
import Security
import UIKit

/// DEBUG + simulator builds ONLY — compiled out of Release and of every
/// device build. Plays the app's side of specs/mobile-local-store.md once,
/// so the provider can be exercised end to end before the app writes the
/// store itself:
///   - LSK (random) → keychain, contract §3 attributes, shared group;
///   - vault.db (SQLCipher) with the TS-encrypted `vault_keys`, `rows`
///     and `autofill_index` from the fixture;
///   - `ios-kc-aesgcm-v1` enrolment: random 32-byte key in the keychain
///     with `.biometryCurrentSet`, AMK sealed with AES-GCM → `device_unlock`.
/// The fixture is copied into the App Group by scripts/seed-simulator.sh
/// and deleted after use.
enum DebugSimulatorSeed {
    static let fixtureFileName = "dev-seed.json"

    struct SeedError: Error, CustomStringConvertible {
        let description: String
    }

    private struct Fixture: Decodable {
        struct Row: Decodable {
            let id: String
            let revision: Int64
            let nonce, ciphertext, wrapped_item_key, wrapped_nonce: String
            let deleted_at: String?
        }
        struct Index: Decodable {
            let id, title, username, host, type: String
        }
        let account_master_key_b64: String
        let stored_keys_json: String
        let rows: [Row]
        let autofill_index: [Index]
    }

    static func button(target: Any, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle("Seed test vault from \(fixtureFileName) (DEBUG simulator)", for: .normal)
        button.titleLabel?.numberOfLines = 0
        button.accessibilityIdentifier = "autofill-debug-seed"
        button.addTarget(target, action: action, for: .touchUpInside)
        return button
    }

    static func run() throws -> String {
        guard let accessGroup = ProviderVault.keychainAccessGroup,
              let directory = VaultDatabase.directoryURL(),
              let dbURL = VaultDatabase.defaultURL() else {
            throw SeedError(description: "App Group container or keychain access group unavailable")
        }
        let fixtureURL = directory.appendingPathComponent(fixtureFileName)
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            throw SeedError(description: "no \(fixtureFileName) in \(directory.path) — run scripts/seed-simulator.sh first")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        guard var amk = Data(base64Encoded: fixture.account_master_key_b64), amk.count == 32 else {
            throw SeedError(description: "fixture AMK is not 32 bytes of base64")
        }
        defer { amk.resetBytes(in: 0..<amk.count) }

        let localStorageKey = try random32()
        let deviceKey = try random32()
        try storeKey(localStorageKey, service: VaultDatabase.localStorageKeyService,
                     account: VaultDatabase.localStorageKeyAccount, accessGroup: accessGroup,
                     protection: .accessible(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly))
        var accessError: Unmanaged<CFError>?
        guard let biometric = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &accessError
        ) else {
            throw SeedError(description: "SecAccessControlCreateWithFlags: \(String(describing: accessError?.takeRetainedValue()))")
        }
        try storeKey(deviceKey, service: DeviceUnlock.keychainService, account: DeviceUnlock.keychainAccount,
                     accessGroup: accessGroup, protection: .accessControl(biometric))
        let sealed = try deviceKey.withUnsafeBytes { try AES.GCM.seal(amk, using: SymmetricKey(data: $0)) }
        guard let wrappedAMK = sealed.combined else { throw SeedError(description: "AES.GCM combined form unavailable") }

        var contents = DevVaultWriter.Contents()
        contents.storedKeysJSON = fixture.stored_keys_json
        contents.rows = fixture.rows.map {
            EncryptedVaultRow(id: $0.id, revision: $0.revision, nonce: $0.nonce, ciphertext: $0.ciphertext,
                              wrappedItemKey: $0.wrapped_item_key, wrappedNonce: $0.wrapped_nonce, deletedAt: $0.deleted_at)
        }
        contents.autofillIndex = fixture.autofill_index.map {
            AutoFillIndexEntry(id: $0.id, title: $0.title, username: $0.username, host: $0.host, type: $0.type)
        }
        contents.deviceUnlock = DeviceUnlockRecord(scheme: DeviceUnlockScheme.keychainAESGCM.rawValue, wrappedAMK: wrappedAMK)
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: dbURL.path + suffix)
        }
        try DevVaultWriter.write(contents, to: dbURL, localStorageKey: localStorageKey)
        try FileManager.default.removeItem(at: fixtureURL)
        return "DEBUG seed: \(contents.rows.count) rows, \(contents.autofillIndex.count) index entries, device unlock \(DeviceUnlockScheme.keychainAESGCM.rawValue)."
    }

    private enum Protection {
        case accessible(CFString)
        case accessControl(SecAccessControl)
    }

    private static func random32() throws -> SecretBytes {
        let key = SecretBytes(count: 32)
        let status = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw SeedError(description: "SecRandomCopyBytes \(status)") }
        return key
    }

    private static func storeKey(_ key: SecretBytes, service: String, account: String, accessGroup: String, protection: Protection) throws {
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        let deleted = SecItemDelete(identity as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            throw SeedError(description: "SecItemDelete \(service): \(deleted)")
        }
        var add = identity
        add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        switch protection {
        case .accessible(let value): add[kSecAttrAccessible as String] = value
        case .accessControl(let value): add[kSecAttrAccessControl as String] = value
        }
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw SeedError(description: "SecItemAdd \(service): \(status)") }
    }
}
#endif
