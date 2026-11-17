import Clibsodium
import Foundation
import XCTest
@testable import AutoFillCore

/// tests/crypto-vectors/argon2id-vectors.json — the same known answers the
/// TypeScript and Rust suites assert. A mismatch means the code is wrong.
final class SharedVectorsTests: XCTestCase {
    struct Vectors: Decodable {
        struct Argon: Decodable {
            struct Vector: Decodable { let id, kek_hex, passphrase, salt_hex: String }
            let opslimit: Int
            let memlimit: Int
            let vectors: [Vector]
        }
        struct Aead: Decodable {
            struct Vector: Decodable { let id, ciphertext_hex, key_hex, nonce_hex, plaintext: String }
            let vectors: [Vector]
        }
        let argon2id: Argon
        let xchacha20poly1305_ietf: Aead
    }

    func load() throws -> Vectors {
        try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: sharedVectorsURL()))
    }

    func testArgon2idProfileAndKEKs() throws {
        let vectors = try load()
        XCTAssertEqual(vectors.argon2id.opslimit, 2)
        XCTAssertEqual(vectors.argon2id.memlimit, 67_108_864)
        XCTAssertEqual(vectors.argon2id.vectors.count, 2)
        for vector in vectors.argon2id.vectors {
            let kek = argon2idKEK(passphrase: vector.passphrase, salt: hexBytes(vector.salt_hex))
            XCTAssertEqual(bytes(kek), hexBytes(vector.kek_hex), vector.id)
        }
    }

    func testXChaCha20Poly1305DecryptsVector() throws {
        for vector in try load().xchacha20poly1305_ietf.vectors {
            let plaintext = try XChaCha20Poly1305.decrypt(
                key: SecretBytes(copying: hexBytes(vector.key_hex)),
                nonce: Data(hexBytes(vector.nonce_hex)),
                ciphertext: Data(hexBytes(vector.ciphertext_hex)),
                layer: vector.id
            )
            XCTAssertEqual(bytes(plaintext), Array(vector.plaintext.utf8), vector.id)
        }
    }

    /// The linked libsodium seals the vector to the same bytes (proves IETF XChaCha, AD null).
    func testLinkedLibsodiumSealsVectorIdentically() throws {
        XCTAssertGreaterThanOrEqual(sodium_init(), 0)
        for vector in try load().xchacha20poly1305_ietf.vectors {
            let message = Array(vector.plaintext.utf8)
            var sealed = [UInt8](repeating: 0, count: message.count + XChaCha20Poly1305.tagBytes)
            var sealedLength: UInt64 = 0
            let rc = crypto_aead_xchacha20poly1305_ietf_encrypt(
                &sealed, &sealedLength, message, UInt64(message.count), nil, 0, nil,
                hexBytes(vector.nonce_hex), hexBytes(vector.key_hex)
            )
            XCTAssertEqual(rc, 0)
            XCTAssertEqual(sealed, hexBytes(vector.ciphertext_hex), vector.id)
        }
    }

    func testTamperedVectorIsRejected() throws {
        let vector = try XCTUnwrap(try load().xchacha20poly1305_ietf.vectors.first)
        var ciphertext = hexBytes(vector.ciphertext_hex)
        ciphertext[ciphertext.count - 1] ^= 0x80
        XCTAssertThrowsError(try XChaCha20Poly1305.decrypt(
            key: SecretBytes(copying: hexBytes(vector.key_hex)),
            nonce: Data(hexBytes(vector.nonce_hex)),
            ciphertext: Data(ciphertext),
            layer: "vector"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .authenticationFailed("vector")) }
    }

    func testRejectsWrongLengths() {
        XCTAssertThrowsError(try XChaCha20Poly1305.decrypt(
            key: SecretBytes(count: 16), nonce: Data(count: 24), ciphertext: Data(count: 32), layer: "x"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .badLength("x key")) }
        XCTAssertThrowsError(try XChaCha20Poly1305.decrypt(
            key: SecretBytes(count: 32), nonce: Data(count: 12), ciphertext: Data(count: 32), layer: "x"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .badLength("x nonce")) }
        XCTAssertThrowsError(try XChaCha20Poly1305.decrypt(
            key: SecretBytes(count: 32), nonce: Data(count: 24), ciphertext: Data(count: 15), layer: "x"
        )) { XCTAssertEqual($0 as? VaultCryptoError, .badLength("x ciphertext")) }
    }
}
