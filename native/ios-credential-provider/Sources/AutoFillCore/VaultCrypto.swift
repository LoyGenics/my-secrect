import Clibsodium
import Foundation

/// Vault crypto v1 (specs/encryption-format.md), decrypt side only.
///
/// XChaCha20-Poly1305 IETF through libsodium, AD = null, 24-byte nonce,
/// ciphertext = ct || 16-byte tag — byte-for-byte what
/// `libsodiumAdapter.decrypt` / `unwrapKey` in packages/crypto-adapters do.
/// The key chain and field encodings are those of apps/mobile/src/vault.ts:
///   AMK --unwrap(wrapped_vault_nonce, wrapped_vault)--> Vault Key
///   Vault Key --unwrap(row.wrapped_nonce, row.wrapped_item_key)--> Item Key
///   Item Key --decrypt(row.nonce, row.ciphertext)--> VaultItem JSON
/// every field standard base64 (btoa), nonce and ciphertext stored apart.
public enum VaultCryptoError: Error, Equatable {
    case sodiumUnavailable
    case malformed(String)
    case badLength(String)
    case authenticationFailed(String)
}

public enum XChaCha20Poly1305 {
    public static let keyBytes = 32
    public static let nonceBytes = 24
    public static let tagBytes = 16

    static func ensureSodium() throws {
        guard sodium_init() >= 0 else { throw VaultCryptoError.sodiumUnavailable }
    }

    /// Decrypts and authenticates. `layer` names what is being opened, for errors.
    public static func decrypt(key: SecretBytes, nonce: Data, ciphertext: Data, layer: String) throws -> SecretBytes {
        try ensureSodium()
        guard key.count == Int(crypto_aead_xchacha20poly1305_ietf_keybytes()) else {
            throw VaultCryptoError.badLength("\(layer) key")
        }
        guard nonce.count == Int(crypto_aead_xchacha20poly1305_ietf_npubbytes()) else {
            throw VaultCryptoError.badLength("\(layer) nonce")
        }
        let tag = Int(crypto_aead_xchacha20poly1305_ietf_abytes())
        guard ciphertext.count >= tag else { throw VaultCryptoError.badLength("\(layer) ciphertext") }

        let plaintext = SecretBytes(count: ciphertext.count - tag)
        var plaintextLength: UInt64 = 0
        // Lengths are checked above, so c, n and k are non-empty buffers.
        let status = plaintext.withUnsafeMutableBytes { m in
            key.withUnsafeBytes { k in
                nonce.withUnsafeBytes { n in
                    ciphertext.withUnsafeBytes { c in
                        crypto_aead_xchacha20poly1305_ietf_decrypt(
                            m.baseAddress?.assumingMemoryBound(to: UInt8.self), &plaintextLength,
                            nil,
                            c.baseAddress!.assumingMemoryBound(to: UInt8.self), UInt64(c.count),
                            nil, 0,
                            n.baseAddress!.assumingMemoryBound(to: UInt8.self),
                            k.baseAddress!.assumingMemoryBound(to: UInt8.self)
                        )
                    }
                }
            }
        }
        guard status == 0, Int(plaintextLength) == plaintext.count else {
            plaintext.wipe()
            throw VaultCryptoError.authenticationFailed(layer)
        }
        return plaintext
    }

    /// `unwrapKey`: the same AEAD over 32 key bytes.
    public static func unwrapKey(wrappingKey: SecretBytes, nonce: Data, wrapped: Data, layer: String) throws -> SecretBytes {
        let key = try decrypt(key: wrappingKey, nonce: nonce, ciphertext: wrapped, layer: layer)
        guard key.count == keyBytes else {
            key.wipe()
            throw VaultCryptoError.badLength("\(layer) unwrapped key")
        }
        return key
    }
}

public enum VaultKeyChain {
    /// The two `StoredKeys` fields the provider needs; the others are ignored.
    struct StoredKeys: Decodable {
        let wrapped_vault: String
        let wrapped_vault_nonce: String
    }

    static func base64(_ value: String, _ field: String) throws -> Data {
        guard let data = Data(base64Encoded: value) else { throw VaultCryptoError.malformed(field) }
        return data
    }

    /// AMK → Vault Key, from the `vault_keys.json` StoredKeys JSON.
    public static func unwrapVaultKey(accountMasterKey: SecretBytes, storedKeysJSON: String) throws -> SecretBytes {
        let keys: StoredKeys
        do {
            keys = try JSONDecoder().decode(StoredKeys.self, from: Data(storedKeysJSON.utf8))
        } catch {
            throw VaultCryptoError.malformed("vault_keys JSON")
        }
        return try XChaCha20Poly1305.unwrapKey(
            wrappingKey: accountMasterKey,
            nonce: try base64(keys.wrapped_vault_nonce, "wrapped_vault_nonce"),
            wrapped: try base64(keys.wrapped_vault, "wrapped_vault"),
            layer: "vault key"
        )
    }

    /// Vault Key → Item Key for one row.
    public static func unwrapItemKey(vaultKey: SecretBytes, row: EncryptedVaultRow) throws -> SecretBytes {
        try XChaCha20Poly1305.unwrapKey(
            wrappingKey: vaultKey,
            nonce: try base64(row.wrappedNonce, "wrapped_nonce"),
            wrapped: try base64(row.wrappedItemKey, "wrapped_item_key"),
            layer: "item key"
        )
    }

    /// Item Key → VaultItem JSON bytes for one row.
    public static func decryptRow(itemKey: SecretBytes, row: EncryptedVaultRow) throws -> SecretBytes {
        try XChaCha20Poly1305.decrypt(
            key: itemKey,
            nonce: try base64(row.nonce, "nonce"),
            ciphertext: try base64(row.ciphertext, "ciphertext"),
            layer: "item"
        )
    }
}
