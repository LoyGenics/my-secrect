import CryptoKit
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

// specs/mobile-local-store.md §1, §3, §4, §5. The iOS Credential Provider
// reuses these exact services / tags / access group from its own code.
private enum Contract {
  static let appGroup = "group.com.loygenics.my-secrect"
  static let storageSubpath = "Library/Application Support/my-secrect"
  static let lskService = "com.loygenics.my-secrect.lsk"
  static let lskAccount = "v1"
  static let kcService = "com.loygenics.my-secrect.device-unlock"
  static let kcAccount = "v1"
  static let seTag = Data("com.loygenics.my-secrect.device-unlock.v1".utf8)
  static let schemeSE = "ios-se-p256-ecies-v1"
  static let schemeKC = "ios-kc-aesgcm-v1"
  static let ecies = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
  /// `$(AppIdentifierPrefix)com.loygenics.my-secrect.shared`, expanded at build
  /// time into Info.plist by plugins/with-mobile-storage.js.
  static let accessGroupInfoKey = "MySecrectKeychainAccessGroup"
}

/// Rejections carry exactly one of the contract §4 codes as `error.code` in JS.
final class DeviceKeyException: Exception {
  private let contractCode: String
  private let detail: String

  init(_ code: String, _ detail: String) {
    contractCode = code
    self.detail = detail
    super.init()
  }

  override var code: String { contractCode }
  override var reason: String { detail }
}

private func fail(_ code: String, _ detail: String) -> DeviceKeyException { DeviceKeyException(code, detail) }

private func accessGroup() throws -> String {
  guard let group = Bundle.main.object(forInfoDictionaryKey: Contract.accessGroupInfoKey) as? String,
        !group.isEmpty, !group.contains("$(") else {
    throw fail("NOT_AVAILABLE", "keychain access group is not configured (Info.plist \(Contract.accessGroupInfoKey))")
  }
  return group
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

private func randomBytes(_ count: Int) throws -> Data {
  var bytes = Data(count: count)
  let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
  guard status == errSecSuccess else { throw fail("NOT_AVAILABLE", "SecRandomCopyBytes failed (\(status))") }
  return bytes
}

/// LAError -> contract code. Device passcode is never offered: the policy is biometrics only.
private func laCode(_ error: Error?) -> String {
  guard let error = error as? LAError else { return "AUTH_FAILED" }
  switch error.code {
  case .userCancel, .appCancel, .systemCancel, .userFallback: return "USER_CANCEL"
  case .biometryLockout: return "LOCKOUT"
  case .biometryNotEnrolled: return "NOT_ENROLLED"
  case .biometryNotAvailable, .passcodeNotSet: return "NOT_AVAILABLE"
  default: return "AUTH_FAILED"
  }
}

private func biometryName(_ context: LAContext) -> String {
  switch context.biometryType {
  case .faceID: return "faceId"
  case .touchID: return "touchId"
  default: return "none"
  }
}

private func newContext(_ prompt: String) -> LAContext {
  let context = LAContext()
  context.localizedReason = prompt
  context.localizedFallbackTitle = "Use passphrase"
  return context
}

/// Biometric check with a fresh context; that evaluated context is then handed to the
/// keychain / Secure Enclave so the item's `.biometryCurrentSet` ACL is satisfied without a
/// second prompt. A changed biometric set still fails at the key, which is KEY_INVALIDATED.
private func authenticate(_ prompt: String, _ done: @escaping (Result<LAContext, DeviceKeyException>) -> Void) {
  let context = newContext(prompt)
  var error: NSError?
  guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
    done(.failure(fail(laCode(error), "biometrics unavailable: \(error?.localizedDescription ?? "unknown")")))
    return
  }
  context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: prompt) { ok, evalError in
    if ok { done(.success(context)) } else { done(.failure(fail(laCode(evalError), evalError?.localizedDescription ?? "authentication failed"))) }
  }
}

private func biometryAccessControl() throws -> SecAccessControl {
  var error: Unmanaged<CFError>?
  guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &error) else {
    throw fail("NOT_AVAILABLE", "access control: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
  }
  return ac
}

private func seAccessControl() throws -> SecAccessControl {
  var error: Unmanaged<CFError>?
  guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error) else {
    throw fail("NOT_AVAILABLE", "access control: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
  }
  return ac
}

// MARK: - Local Storage Key (contract §3)

private let lskLock = NSLock()

private func getOrCreateStorageKey() throws -> String {
  lskLock.lock(); defer { lskLock.unlock() }
  let group = try accessGroup()
  let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: Contract.lskService,
    kSecAttrAccount as String: Contract.lskAccount,
    kSecAttrAccessGroup as String: group,
  ]
  func read() throws -> Data? {
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = out as? Data else { throw fail("NOT_AVAILABLE", "reading the storage key failed (\(status))") }
    guard data.count == 32 else { throw fail("CORRUPT", "storage key has \(data.count) bytes") }
    return data
  }
  if let existing = try read() { return hex(existing) }
  var key = try randomBytes(32)
  defer { key.resetBytes(in: 0..<key.count) }
  var add = base
  add[kSecValueData as String] = key
  add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  let status = SecItemAdd(add as CFDictionary, nil)
  if status == errSecDuplicateItem, let raced = try read() { return hex(raced) } // the extension created it first
  guard status == errSecSuccess else { throw fail("NOT_AVAILABLE", "storing the storage key failed (\(status))") }
  return hex(key)
}

// MARK: - Device-unlock key items (contract §4)

private func seKeyQuery(_ group: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassKey,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrApplicationTag as String: Contract.seTag,
    kSecAttrAccessGroup as String: group,
  ]
}

private func kcItemQuery(_ group: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: Contract.kcService,
    kSecAttrAccount as String: Contract.kcAccount,
    kSecAttrAccessGroup as String: group,
  ]
}

private func removeKeys() throws {
  let group = try accessGroup()
  for query in [seKeyQuery(group), kcItemQuery(group)] {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw fail("NOT_AVAILABLE", "deleting the device key failed (\(status))")
    }
  }
}

/// Does the item exist? Attributes need no authentication, so this never prompts.
private func itemExists(_ query: [String: Any]) -> Bool {
  var q = query
  q[kSecReturnAttributes as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  let context = LAContext()
  context.interactionNotAllowed = true
  q[kSecUseAuthenticationContext as String] = context
  let status = SecItemCopyMatching(q as CFDictionary, nil)
  return status == errSecSuccess || status == errSecInteractionNotAllowed
}

/// Contract §4: the simulator uses ios-kc-aesgcm-v1. (CryptoKit reports a Secure Enclave on
/// Apple-silicon simulators, but SE key generation there fails with errSecAuthFailed.)
private func seAvailable() -> Bool {
  #if targetEnvironment(simulator)
  return false
  #else
  return SecureEnclave.isAvailable
  #endif
}

private func currentScheme() -> String { seAvailable() ? Contract.schemeSE : Contract.schemeKC }

/// SE: P-256 key born in the Secure Enclave; only the public half encrypts.
private func seWrap(_ amk: Data, _ group: String) throws -> Data {
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: Contract.seTag,
      kSecAttrAccessControl as String: try seAccessControl(),
      kSecAttrAccessGroup as String: group,
    ] as [String: Any],
  ]
  var error: Unmanaged<CFError>?
  guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
        let publicKey = SecKeyCopyPublicKey(privateKey) else {
    throw fail("NOT_AVAILABLE", "Secure Enclave key: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
  }
  guard let wrapped = SecKeyCreateEncryptedData(publicKey, Contract.ecies, amk as CFData, &error) as Data? else {
    throw fail("CORRUPT", "ECIES wrap: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
  }
  return wrapped
}

private func seUnwrap(_ blob: Data, _ group: String, _ context: LAContext) throws -> Data {
  var query = seKeyQuery(group)
  query[kSecReturnRef as String] = true
  query[kSecUseAuthenticationContext as String] = context
  var out: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &out)
  if status == errSecItemNotFound { throw fail("KEY_INVALIDATED", "device key is gone") }
  guard status == errSecSuccess, let ref = out else { throw fail("KEY_INVALIDATED", "device key unusable (\(status))") }
  let privateKey = ref as! SecKey // swiftlint:disable:this force_cast — kSecReturnRef on kSecClassKey is a SecKey
  var error: Unmanaged<CFError>?
  guard let amk = SecKeyCreateDecryptedData(privateKey, Contract.ecies, blob as CFData, &error) as Data? else {
    let nsError = error.map { $0.takeRetainedValue() as Error as NSError }
    // After a biometric change the key refuses use even with a fresh match.
    if nsError?.code == Int(errSecAuthFailed) || nsError?.code == Int(errSecUserCanceled) || nsError?.code == Int(errSecInteractionNotAllowed) {
      throw fail("KEY_INVALIDATED", "Secure Enclave key refused: \(nsError?.localizedDescription ?? "")")
    }
    throw fail("CORRUPT", "ECIES unwrap: \(nsError?.localizedDescription ?? "unknown")")
  }
  return amk
}

/// No SE (simulator): random AES-256 key stored as a biometry-gated keychain item.
private func kcWrap(_ amk: Data, _ group: String) throws -> Data {
  var keyBytes = try randomBytes(32)
  defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
  var add = kcItemQuery(group)
  add[kSecValueData as String] = keyBytes
  add[kSecAttrAccessControl as String] = try biometryAccessControl()
  let status = SecItemAdd(add as CFDictionary, nil)
  guard status == errSecSuccess else { throw fail("NOT_AVAILABLE", "storing the device key failed (\(status))") }
  do {
    guard let combined = try AES.GCM.seal(amk, using: SymmetricKey(data: keyBytes)).combined else {
      throw fail("CORRUPT", "AES-GCM produced no combined box")
    }
    return combined
  } catch let e as DeviceKeyException {
    throw e
  } catch {
    throw fail("CORRUPT", "AES-GCM wrap: \(error.localizedDescription)")
  }
}

private func kcUnwrap(_ blob: Data, _ group: String, _ context: LAContext) throws -> Data {
  var query = kcItemQuery(group)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  query[kSecUseAuthenticationContext as String] = context
  var out: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &out)
  switch status {
  case errSecSuccess: break
  case errSecItemNotFound, errSecAuthFailed, errSecInteractionNotAllowed, errSecUserCanceled:
    throw fail("KEY_INVALIDATED", "device key unusable (\(status))")
  default:
    throw fail("NOT_AVAILABLE", "reading the device key failed (\(status))")
  }
  guard var keyBytes = out as? Data, keyBytes.count == 32 else { throw fail("CORRUPT", "device key has the wrong size") }
  defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
  do {
    return try AES.GCM.open(AES.GCM.SealedBox(combined: blob), using: SymmetricKey(data: keyBytes))
  } catch {
    throw fail("CORRUPT", "AES-GCM unwrap failed")
  }
}

private func unwrapWith(_ scheme: String, _ blob: Data, _ group: String, _ context: LAContext) throws -> Data {
  switch scheme {
  case Contract.schemeSE: return try seUnwrap(blob, group, context)
  case Contract.schemeKC: return try kcUnwrap(blob, group, context)
  default: throw fail("CORRUPT", "unknown scheme \(scheme)")
  }
}

public class DeviceKeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeviceKey")

    /// Contract §1: App Group container, Library/Application Support/my-secrect/.
    AsyncFunction("getStorageDirectory") { () throws -> String in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Contract.appGroup) else {
        throw fail("NOT_AVAILABLE", "App Group \(Contract.appGroup) container is unavailable (entitlement missing?)")
      }
      let dir = container.appendingPathComponent(Contract.storageSubpath, isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      return dir.path
    }

    AsyncFunction("isAvailable") { () -> [String: Any] in
      let context = LAContext()
      var error: NSError?
      let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
      let biometry = biometryName(context) // set by canEvaluatePolicy, even when it fails
      var result: [String: Any] = ["available": available, "biometry": biometry, "scheme": NSNull()]
      if biometry != "none" { result["scheme"] = currentScheme() }
      return result
    }

    AsyncFunction("getOrCreateStorageKey") { () throws -> String in
      try getOrCreateStorageKey()
    }

    AsyncFunction("enroll") { (amkB64: String, prompt: String, promise: Promise) in
      guard var amk = Data(base64Encoded: amkB64), amk.count == 32 else {
        promise.reject(fail("CORRUPT", "AMK must be 32 bytes"))
        return
      }
      let scheme = currentScheme()
      let group: String
      let wrapped: Data
      do {
        group = try accessGroup()
        let probe = LAContext()
        var error: NSError?
        guard probe.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
          throw fail(laCode(error), "biometrics unavailable: \(error?.localizedDescription ?? "unknown")")
        }
        try removeKeys()
        wrapped = scheme == Contract.schemeSE ? try seWrap(amk, group) : try kcWrap(amk, group)
      } catch {
        amk.resetBytes(in: 0..<amk.count)
        try? removeKeys()
        promise.reject(error as? DeviceKeyException ?? fail("CORRUPT", error.localizedDescription))
        return
      }
      // Prove the user can release it before the app stores the row.
      authenticate(prompt) { result in
        defer { amk.resetBytes(in: 0..<amk.count) }
        do {
          let context = try result.get()
          var roundTrip = try unwrapWith(scheme, wrapped, group, context)
          defer { roundTrip.resetBytes(in: 0..<roundTrip.count) }
          guard roundTrip == amk else { throw fail("CORRUPT", "round trip mismatch") }
          promise.resolve(["scheme": scheme, "wrappedAmkB64": wrapped.base64EncodedString()])
        } catch {
          try? removeKeys()
          promise.reject(error as? DeviceKeyException ?? fail("CORRUPT", error.localizedDescription))
        }
      }
    }

    AsyncFunction("unwrap") { (scheme: String, wrappedAmkB64: String, prompt: String, promise: Promise) in
      let group: String
      let blob: Data
      do {
        guard scheme == Contract.schemeSE || scheme == Contract.schemeKC else { throw fail("CORRUPT", "unknown scheme \(scheme)") }
        if scheme == Contract.schemeSE && !seAvailable() { throw fail("CORRUPT", "Secure Enclave scheme on a device without one") }
        guard let decoded = Data(base64Encoded: wrappedAmkB64), !decoded.isEmpty else { throw fail("CORRUPT", "wrapped AMK is not base64") }
        blob = decoded
        group = try accessGroup()
        guard itemExists(scheme == Contract.schemeSE ? seKeyQuery(group) : kcItemQuery(group)) else {
          throw fail("KEY_INVALIDATED", "device key is gone")
        }
      } catch {
        promise.reject(error as? DeviceKeyException ?? fail("CORRUPT", error.localizedDescription))
        return
      }
      authenticate(prompt) { result in
        do {
          let context = try result.get()
          var amk = try unwrapWith(scheme, blob, group, context)
          defer { amk.resetBytes(in: 0..<amk.count) }
          guard amk.count == 32 else { throw fail("CORRUPT", "unwrapped AMK has \(amk.count) bytes") }
          promise.resolve(amk.base64EncodedString())
        } catch {
          let e = error as? DeviceKeyException ?? fail("CORRUPT", error.localizedDescription)
          if e.code == "KEY_INVALIDATED" { try? removeKeys() }
          promise.reject(e)
        }
      }
    }

    AsyncFunction("remove") { () throws in
      try removeKeys()
    }
  }
}
