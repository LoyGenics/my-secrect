import Clibsodium
import Foundation
import XCTest
@testable import AutoFillCore

/// tests/AutoFillCoreTests/Fixtures/autofill-fixture.json, written by
/// tests/generate-fixtures.ts with the real TypeScript crypto.
struct TSFixture: Decodable {
    struct Row: Decodable {
        let id: String
        let revision: Int64
        let nonce: String
        let ciphertext: String
        let wrapped_item_key: String
        let wrapped_nonce: String
        let deleted_at: String?

        var encrypted: EncryptedVaultRow {
            EncryptedVaultRow(id: id, revision: revision, nonce: nonce, ciphertext: ciphertext,
                              wrappedItemKey: wrapped_item_key, wrappedNonce: wrapped_nonce, deletedAt: deleted_at)
        }
    }
    struct Index: Decodable {
        let id, title, username, host, type: String
        var entry: AutoFillIndexEntry { AutoFillIndexEntry(id: id, title: title, username: username, host: host, type: type) }
    }
    struct Expected: Decodable {
        let id, username, password: String
    }

    let passphrase: String
    let account_master_key_b64: String
    let stored_keys_json: String
    let rows: [Row]
    let autofill_index: [Index]
    let expected_logins: [Expected]

    static func load() throws -> TSFixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "autofill-fixture", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(TSFixture.self, from: Data(contentsOf: url))
    }

    var accountMasterKey: SecretBytes { SecretBytes(copying: Data(base64Encoded: account_master_key_b64)!) }

    func row(_ id: String) -> EncryptedVaultRow { rows.first { $0.id == id }!.encrypted }
    func host(_ id: String) -> String { autofill_index.first { $0.id == id }!.host }

    var contents: DevVaultWriter.Contents {
        var contents = DevVaultWriter.Contents()
        contents.storedKeysJSON = stored_keys_json
        contents.rows = rows.map(\.encrypted)
        contents.autofillIndex = autofill_index.map(\.entry)
        return contents
    }
}

/// The repo's shared cross-platform vectors, read in place (never copied).
func sharedVectorsURL() -> URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() } // AutoFillCoreTests, tests, ios-credential-provider, native → repo root
    return url.appendingPathComponent("tests/crypto-vectors/argon2id-vectors.json")
}

func randomSecret(_ count: Int) -> SecretBytes {
    let secret = SecretBytes(count: count)
    secret.withUnsafeMutableBytes { randombytes_buf($0.baseAddress!, count) }
    return secret
}

func bytes(_ secret: SecretBytes) -> [UInt8] { secret.withUnsafeBytes { Array($0) } }

func hexBytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        out.append(UInt8(hex[index..<next], radix: 16)!)
        index = next
    }
    return out
}

/// Argon2id with the locked v1 profile (ops 2, mem 64 MiB), via libsodium.
func argon2idKEK(passphrase: String, salt: [UInt8]) -> SecretBytes {
    XCTAssertEqual(sodium_init() >= 0, true)
    let kek = SecretBytes(count: 32)
    let password = Array(passphrase.utf8)
    let rc = kek.withUnsafeMutableBytes { out in
        password.withUnsafeBufferPointer { pw in
            pw.baseAddress!.withMemoryRebound(to: CChar.self, capacity: pw.count) { pwc in
                crypto_pwhash(out.baseAddress!.assumingMemoryBound(to: UInt8.self), 32,
                              pwc, UInt64(pw.count), salt, 2, 67_108_864, crypto_pwhash_alg_argon2id13())
            }
        }
    }
    XCTAssertEqual(rc, 0)
    return kek
}

/// Flips one bit of a base64 field (tamper helper).
func flipBit(_ base64: String, at byteIndex: Int = 0) -> String {
    var data = Data(base64Encoded: base64)!
    data[byteIndex] ^= 0x01
    return data.base64EncodedString()
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("autofill-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
