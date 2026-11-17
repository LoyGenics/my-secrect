import Clibsodium
import Foundation

/// Heap buffer for key material and decrypted plaintext.
///
/// Wiped with `sodium_memzero` by `wipe()` and again on deinit. Key bytes
/// live here from the moment they leave libsodium / CryptoKit /
/// Security.framework until they are used. Buffers owned by those
/// frameworks (keychain `CFData`, Foundation strings handed to
/// `ASPasswordCredential`) are outside our control and are not wiped.
public final class SecretBytes {
    public let count: Int
    private let pointer: UnsafeMutableRawPointer

    public init(count: Int) {
        precondition(count >= 0, "negative SecretBytes size")
        self.count = count
        pointer = UnsafeMutableRawPointer.allocate(byteCount: count, alignment: 16)
        sodium_memzero(pointer, count)
    }

    /// Copies `bytes` in; the caller still owns (and wipes) the source.
    public convenience init<D: ContiguousBytes>(copying bytes: D) {
        let length = bytes.withUnsafeBytes { $0.count }
        self.init(count: length)
        bytes.withUnsafeBytes { source in
            if let base = source.baseAddress, length > 0 {
                pointer.copyMemory(from: base, byteCount: length)
            }
        }
    }

    deinit {
        sodium_memzero(pointer, count)
        pointer.deallocate()
    }

    public func wipe() {
        sodium_memzero(pointer, count)
    }

    public func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try body(UnsafeRawBufferPointer(start: pointer, count: count))
    }

    public func withUnsafeMutableBytes<R>(_ body: (UnsafeMutableRawBufferPointer) throws -> R) rethrows -> R {
        try body(UnsafeMutableRawBufferPointer(start: pointer, count: count))
    }
}

/// Zero a Swift-owned `Data` in place (it must be uniquely referenced,
/// e.g. the plaintext CryptoKit just returned).
func wipe(_ data: inout Data) {
    data.withUnsafeMutableBytes { buffer in
        if let base = buffer.baseAddress { sodium_memzero(base, buffer.count) }
    }
}
