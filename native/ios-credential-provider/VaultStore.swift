import AuthenticationServices
import Foundation
import Security

/// Access to the vault's encrypted store from the Credential Provider
/// extension. Read this header before trusting anything in this file.
///
/// WHAT IS REAL HERE
/// - The encrypted-row format below mirrors the desktop vault exactly
///   (`apps/desktop/src/vault.ts` / `apps/extension/src/lib/vault-ext.ts`):
///   one XChaCha20-Poly1305 row per item, fresh nonce, Vault-Key-wrapped
///   per-item key. Rows are Codable-parsed from the App Group shared
///   container — that parsing code is real.
/// - The metadata index (`vault-metadata.json`) holds ONLY titles,
///   usernames and hosts — never passwords, never keys, never ciphertext.
///   It exists so the extension can list *which* logins match a domain
///   without decrypting anything.
/// - `DeviceKeyStore` is real Security-framework code: it stores a random
///   32-byte device wrapping key in the Keychain, gated by biometrics
///   (`biometryCurrentSet`) and bound to this device
///   (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). It never stores a
///   vault key, a passphrase, or a credential.
///
/// WHAT IS NOT DONE (fail closed — see README.md)
/// - The main app does NOT write `vault-rows.json` or
///   `vault-metadata.json` into the App Group yet, so `readRows()` /
///   `readMetadata()` throw `.storeUnavailable` in practice today.
/// - Decryption is NOT implemented: the extension never receives the Vault
///   Key. `credential(for:)` throws `.notImplemented` rather than returning
///   a fake or empty credential. The unlock handoff (main app unlocks,
///   hands a single-item decryption to the extension) is the remaining
///   design + Xcode work.
/// - No credential is ever stored in plaintext. Do not "fix" the missing
///   decryption by writing passwords to the Keychain or by returning an
///   empty credential.

public enum VaultStoreError: Error, Equatable {
    case storeUnavailable(String)
    case corruptStore(String)
    case notImplemented(String)
}

/// One encrypted vault row — same shape as the desktop/extension stores.
/// `nonce` + `ciphertext` are base64; `wrapped_item_key` is the per-item
/// key wrapped under the Vault Key (base64), `wrapped_nonce` its nonce.
public struct EncryptedVaultRow: Codable, Equatable {
    public let id: String
    public let revision: Int
    public let nonce: String
    public let ciphertext: String
    public let wrapped_item_key: String
    public let wrapped_nonce: String
    public let deleted_at: String?
}

/// Unencrypted index entry. Titles/usernames/hosts ONLY — no secrets.
/// Written by the main app after a successful unlock; read by the
/// extension to build the credential list for a domain.
public struct LoginMetadata: Codable, Equatable {
    public let id: String
    public let title: String
    public let username: String
    /// Host of the item's stored URL, already normalised (no www, lowercase).
    public let host: String
    public let type: String
}

public final class VaultStore {
    public static let shared = VaultStore()

    /// Must match the App Group in the entitlements of BOTH the main app
    /// target and this extension target, and the group id enabled in the
    /// Apple Developer portal. See README.md.
    public static let appGroupID = "group.com.loygenics.my-secrect"

    /// File names inside the App Group container, under
    /// `Library/Application Support/my-secrect/`. Agreed layout only — the
    /// main app does not write these files yet.
    public static let rowsFileName = "vault-rows.json"
    public static let metadataFileName = "vault-metadata.json"

    private init() {}

    public func containerURL() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupID)
    }

    private func storeURL(fileName: String) -> URL? {
        containerURL()?
            .appendingPathComponent("Library/Application Support/my-secrect", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }

    /// Real parsing of the encrypted rows. Throws `.storeUnavailable` when
    /// the main app has not written the file yet (the case today).
    public func readRows() throws -> [EncryptedVaultRow] {
        guard let url = storeURL(fileName: Self.rowsFileName) else {
            throw VaultStoreError.storeUnavailable("App Group container unavailable (\(Self.appGroupID)).")
        }
        guard let data = try? Data(contentsOf: url) else {
            throw VaultStoreError.storeUnavailable("No vault rows in the App Group yet — the main app has not shared its store.")
        }
        do {
            return try JSONDecoder().decode([EncryptedVaultRow].self, from: data)
        } catch {
            throw VaultStoreError.corruptStore("vault-rows.json is not valid JSON: \(error.localizedDescription)")
        }
    }

    /// Real parsing of the metadata index (titles/usernames/hosts only).
    public func readMetadata() throws -> [LoginMetadata] {
        guard let url = storeURL(fileName: Self.metadataFileName) else {
            throw VaultStoreError.storeUnavailable("App Group container unavailable (\(Self.appGroupID)).")
        }
        guard let data = try? Data(contentsOf: url) else {
            throw VaultStoreError.storeUnavailable("No metadata index in the App Group yet — the main app has not shared it.")
        }
        do {
            return try JSONDecoder().decode([LoginMetadata].self, from: data)
        } catch {
            throw VaultStoreError.corruptStore("vault-metadata.json is not valid JSON: \(error.localizedDescription)")
        }
    }

    /// Build the credential identities the system shows for the requested
    /// service identifiers. Only logins whose host matches the requested
    /// domain (exact or subdomain, both ways) are offered — never the
    /// whole vault. Throws `.storeUnavailable` until the main app writes
    /// the metadata index.
    public func loginIdentities(
        matching serviceIdentifiers: [ASCredentialServiceIdentifier]
    ) throws -> [ASPasswordCredentialIdentity] {
        let metadata = try readMetadata()
        var identities: [ASPasswordCredentialIdentity] = []
        for service in serviceIdentifiers {
            guard service.type == .domain else { continue }
            let requestedHost = DomainMatching.normalizeHost(service.identifier)
            for entry in metadata where entry.type == "login" || entry.type == "passkey" {
                guard DomainMatching.domainsMatch(requestedHost, entry.host) else { continue }
                identities.append(ASPasswordCredentialIdentity(
                    serviceIdentifier: service,
                    user: entry.username,
                    recordIdentifier: entry.id
                ))
            }
        }
        return identities
    }

    /// NOT IMPLEMENTED. Decrypting one item needs the Vault Key, which the
    /// extension does not have and must never be given in bulk. The
    /// remaining work is the unlock handoff from the main app (see
    /// README.md). Throws `.notImplemented` so AutoFill can cancel —
    /// never return an empty or fabricated credential, and never write
    /// plaintext to the Keychain.
    public func credential(for identity: ASPasswordCredentialIdentity) throws -> ASPasswordCredential {
        throw VaultStoreError.notImplemented("not implemented: my-secrect credential decryption — the Credential Provider extension has no Vault Key yet. The main app must hand over a single-item decryption after unlock (see native/ios-credential-provider/README.md). Identity requested: \(identity.recordIdentifier ?? "?")")
    }
}

/// Device-protected wrapping key (Keychain, biometrics-gated).
///
/// This stores ONE random 32-byte key that a future enrolment flow can use
/// to wrap a copy of the Account Master Key — the same shape as the
/// recovery-key wrapping in `apps/desktop/src/vault.ts`. It does NOT store
/// the Master Key itself, and nothing in this file creates that wrapping
/// yet. The key is invalidated when biometrics enrolment changes
/// (`biometryCurrentSet`), so a newly added fingerprint cannot unlock an
/// old wrapping — the user re-enrols with the passphrase.
public enum DeviceKeyStore {
    public static let service = "com.loygenics.my-secrect.device-key"
    public static let account = "device-wrapping-key"

    public static func storeDeviceWrappingKey(_ key: Data) -> Bool {
        precondition(key.count == 32, "device wrapping key must be 32 bytes")
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .biometryCurrentSet,
            nil
        ) else { return false }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: key,
            kSecAttrAccessControl as String: accessControl,
            kSecUseDataProtectionKeychain as String: true,
        ]
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess { return true }
        guard addStatus == errSecDuplicateItem else { return false }
        // Replace the existing item (re-enrolment): delete, then add.
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        guard SecItemDelete(deleteQuery as CFDictionary) == errSecSuccess else { return false }
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    /// Returns the 32-byte device wrapping key after a biometric prompt,
    /// or nil when there is none / the user cancels / enrolment changed.
    /// The caller must zero the returned bytes after use.
    public static func loadDeviceWrappingKey() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseOperationPrompt as String: "Authenticate to unlock my-secrect",
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, data.count == 32 else { return nil }
        return data
    }

    /// Revocation: delete the device wrapping key ("Disable biometric
    /// unlock" and biometric-enrolment-change handling call this).
    @discardableResult
    public static func deleteDeviceWrappingKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
