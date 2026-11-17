import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Biometric release of the Account Master Key (specs/mobile-local-store.md §4).
///
/// The app enrols (writes the key and the `device_unlock` row); the
/// provider only reads. Error codes are the contract's; nothing but a
/// successful unwrap may unlock the vault.
public enum DeviceUnlockError: String, Error, Equatable {
    case notAvailable = "NOT_AVAILABLE"
    case notEnrolled = "NOT_ENROLLED"
    case keyInvalidated = "KEY_INVALIDATED"
    case userCancel = "USER_CANCEL"
    case lockout = "LOCKOUT"
    case authFailed = "AUTH_FAILED"
    case corrupt = "CORRUPT"
}

public enum DeviceUnlockScheme: String {
    case secureEnclaveECIES = "ios-se-p256-ecies-v1"
    case keychainAESGCM = "ios-kc-aesgcm-v1"
}

public enum DeviceUnlock {
    /// `ios-se-p256-ecies-v1`: SE P-256 private key application tag.
    public static let secureEnclaveKeyTag = "com.loygenics.my-secrect.device-unlock.v1"
    /// `ios-kc-aesgcm-v1`: generic password holding the 32-byte AES key.
    public static let keychainService = "com.loygenics.my-secrect.device-unlock"
    public static let keychainAccount = "v1"

    /// Face ID / Touch ID prompt. On success the returned context is passed
    /// to `unwrapAccountMasterKey` so the keychain does not prompt again.
    /// The completion runs on a LocalAuthentication queue, not main.
    public static func authenticate(reason: String, completion: @escaping (Result<LAContext, DeviceUnlockError>) -> Void) {
        let context = LAContext()
        // No passcode fallback: the key is `.biometryCurrentSet`, a passcode cannot release it.
        context.localizedFallbackTitle = ""
        var canError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &canError) else {
            completion(.failure(map(laError: canError)))
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
            completion(success ? .success(context) : .failure(map(laError: error)))
        }
    }

    /// Releases the AMK with a context that already passed biometrics.
    /// Blocks on keychain / Secure Enclave work: call off the main thread.
    public static func unwrapAccountMasterKey(_ record: DeviceUnlockRecord, accessGroup: String, context: LAContext) throws -> SecretBytes {
        guard let scheme = DeviceUnlockScheme(rawValue: record.scheme) else { throw DeviceUnlockError.corrupt }
        switch scheme {
        case .keychainAESGCM:
            let deviceKey = try copyKeychainDeviceKey(accessGroup: accessGroup, context: context)
            defer { deviceKey.wipe() }
            return try openKeychainAESGCM(wrappedAMK: record.wrappedAMK, deviceKey: deviceKey)
        case .secureEnclaveECIES:
            let privateKey = try copySecureEnclaveKey(accessGroup: accessGroup, context: context)
            return try openSecureEnclaveECIES(wrappedAMK: record.wrappedAMK, privateKey: privateKey)
        }
    }

    // MARK: - Scheme blob formats (pure; unit-tested)

    /// `ios-kc-aesgcm-v1`: CryptoKit `AES.GCM.seal(amk).combined` (nonce 12 ‖ ct ‖ tag 16).
    public static func openKeychainAESGCM(wrappedAMK: Data, deviceKey: SecretBytes) throws -> SecretBytes {
        guard deviceKey.count == 32 else { throw DeviceUnlockError.corrupt }
        let key = deviceKey.withUnsafeBytes { SymmetricKey(data: $0) }
        guard let box = try? AES.GCM.SealedBox(combined: wrappedAMK),
              var amk = try? AES.GCM.open(box, using: key) else {
            throw DeviceUnlockError.corrupt
        }
        defer { wipe(&amk) }
        guard amk.count == 32 else { throw DeviceUnlockError.corrupt }
        return SecretBytes(copying: amk)
    }

    /// `ios-se-p256-ecies-v1`: `SecKeyCreateEncryptedData(pub, .eciesEncryptionCofactorVariableIVX963SHA256AESGCM, amk)`.
    public static func openSecureEnclaveECIES(wrappedAMK: Data, privateKey: SecKey) throws -> SecretBytes {
        var error: Unmanaged<CFError>?
        guard let plaintext = SecKeyCreateDecryptedData(
            privateKey, .eciesEncryptionCofactorVariableIVX963SHA256AESGCM, wrappedAMK as CFData, &error
        ) else {
            throw map(cfError: error?.takeRetainedValue())
        }
        let amk = SecretBytes(copying: plaintext as Data)
        guard amk.count == 32 else { throw DeviceUnlockError.corrupt }
        return amk
    }

    // MARK: - Keychain lookups

    static func copyKeychainDeviceKey(accessGroup: String, context: LAContext) throws -> SecretBytes {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { throw map(status: status) }
        guard let data = item as? Data else { throw DeviceUnlockError.corrupt }
        return SecretBytes(copying: data)
    }

    static func copySecureEnclaveKey(accessGroup: String, context: LAContext) throws -> SecKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrApplicationTag as String: Data(secureEnclaveKeyTag.utf8),
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { throw map(status: status) }
        guard let item, CFGetTypeID(item) == SecKeyGetTypeID() else { throw DeviceUnlockError.corrupt }
        return item as! SecKey // CF type: identity checked above
    }

    // MARK: - Error mapping (contract §4 codes)

    static func map(laError error: Error?) -> DeviceUnlockError {
        guard let error = error as? LAError else { return .authFailed }
        return map(laCode: error.code)
    }

    static func map(laCode code: LAError.Code) -> DeviceUnlockError {
        switch code {
        case .userCancel, .appCancel, .systemCancel, .userFallback:
            return .userCancel
        case .biometryNotAvailable, .passcodeNotSet:
            return .notAvailable
        case .biometryNotEnrolled:
            return .notEnrolled
        case .biometryLockout:
            return .lockout
        default:
            return .authFailed
        }
    }

    static func map(status: OSStatus) -> DeviceUnlockError {
        switch status {
        case errSecItemNotFound:
            // Deleted, or invalidated by a biometric enrolment change.
            return .keyInvalidated
        case errSecUserCanceled:
            return .userCancel
        case errSecInteractionNotAllowed, errSecNotAvailable:
            return .notAvailable
        default:
            return .authFailed
        }
    }

    static func map(cfError: CFError?) -> DeviceUnlockError {
        guard let cfError else { return .corrupt }
        let nsError = cfError as Error as NSError
        if nsError.domain == LAError.errorDomain, let code = LAError.Code(rawValue: nsError.code) {
            return map(laCode: code)
        }
        if nsError.domain == NSOSStatusErrorDomain {
            switch OSStatus(nsError.code) {
            case errSecUserCanceled: return .userCancel
            case errSecAuthFailed, errSecInteractionNotAllowed: return .authFailed
            default: return .corrupt
            }
        }
        return .corrupt
    }
}
