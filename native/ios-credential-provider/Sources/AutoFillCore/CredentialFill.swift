import Foundation

/// The username and password of ONE login item — all the provider returns.
public struct LoginSecret {
    public let username: String
    public let password: String
}

public enum FillError: Error, Equatable {
    /// No row, or the row is in the Trash.
    case itemNotFound
    /// The decrypted item is not a login, or has no password.
    case notALogin
    /// The item's own (authenticated) URL does not match the requesting site.
    case domainMismatch
    /// The decrypted item is not a valid v1 VaultItem for this row.
    case invalidItem(String)
}

public enum CredentialFill {
    /// Contract §6 step 3 after the AMK is released: AMK → Vault Key →
    /// Item Key → this one row → username + password. Every intermediate
    /// key and the plaintext JSON are wiped before returning.
    ///
    /// `pageHost` is the host AutoFill asked for. It is checked against
    /// the URL inside the decrypted item, so a tampered `autofill_index`
    /// host cannot steer a credential to another site.
    public static func decryptLogin(
        row: EncryptedVaultRow,
        storedKeysJSON: String,
        accountMasterKey: SecretBytes,
        pageHost: String
    ) throws -> LoginSecret {
        guard row.deletedAt == nil else { throw FillError.itemNotFound }
        let vaultKey = try VaultKeyChain.unwrapVaultKey(accountMasterKey: accountMasterKey, storedKeysJSON: storedKeysJSON)
        defer { vaultKey.wipe() }
        let itemKey = try VaultKeyChain.unwrapItemKey(vaultKey: vaultKey, row: row)
        defer { itemKey.wipe() }
        let plaintext = try VaultKeyChain.decryptRow(itemKey: itemKey, row: row)
        defer { plaintext.wipe() }

        guard plaintext.count > 0 else { throw FillError.invalidItem("empty item") }
        let object: Any
        do {
            object = try plaintext.withUnsafeBytes { buffer in
                // No copy: Foundation parses straight from the wiped buffer.
                let data = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: buffer.baseAddress!),
                                count: buffer.count, deallocator: .none)
                return try JSONSerialization.jsonObject(with: data)
            }
        } catch {
            throw FillError.invalidItem("item JSON does not parse")
        }
        guard let item = object as? [String: Any] else { throw FillError.invalidItem("item JSON is not an object") }
        // Same guard as decryptRows() in apps/mobile/src/vault.ts.
        guard item["id"] as? String == row.id else { throw FillError.invalidItem("decrypted item id does not match the row id") }
        guard item["schema_version"] as? Int == 1 else { throw FillError.invalidItem("unsupported schema_version") }
        guard item["type"] as? String == "login", let fields = item["fields"] as? [String: Any] else {
            throw FillError.notALogin
        }
        guard let password = fields["password"] as? String, !password.isEmpty else { throw FillError.notALogin }
        let username = fields["username"] as? String ?? ""

        guard let url = fields["url"] as? String, let itemHost = host(ofItemURL: url),
              DomainMatching.domainsMatch(pageHost, itemHost) else {
            throw FillError.domainMismatch
        }
        return LoginSecret(username: username, password: password)
    }

    /// Item URLs are user-entered; accept a missing scheme like the app's index does.
    static func host(ofItemURL url: String) -> String? {
        if let host = DomainMatching.host(of: url), !host.isEmpty { return host }
        if let host = DomainMatching.host(of: "https://" + url), !host.isEmpty { return host }
        return nil
    }
}
