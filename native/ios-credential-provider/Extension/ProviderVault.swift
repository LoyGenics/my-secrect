import Foundation

/// Opens the shared store the way contract §6 step 1 describes:
/// LSK from the shared keychain group, then vault.db in the App Group.
enum ProviderVault {
    /// `$(AppIdentifierPrefix)com.loygenics.my-secrect.shared`, expanded into
    /// Info.plist at build time so it always equals the entitlement.
    static var keychainAccessGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "MySecrectKeychainAccessGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { return nil }
        return group
    }

    static func open() throws -> VaultDatabase {
        guard let group = keychainAccessGroup else {
            throw VaultDatabaseError.missing("keychain access group (Info.plist MySecrectKeychainAccessGroup)")
        }
        guard let url = VaultDatabase.defaultURL() else {
            throw VaultDatabaseError.missing("App Group container \(VaultDatabase.appGroupID)")
        }
        let localStorageKey = try VaultDatabase.loadLocalStorageKey(accessGroup: group)
        defer { localStorageKey.wipe() }
        return try VaultDatabase(url: url, localStorageKey: localStorageKey)
    }
}
