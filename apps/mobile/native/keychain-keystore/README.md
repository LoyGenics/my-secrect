# Keychain (iOS) / Keystore (Android) — implemented in `modules/device-key`

The contract is `specs/mobile-local-store.md` (§3 Local Storage Key, §4
device unlock, §5 module API). The code is the local Expo module
`apps/mobile/modules/device-key`:

- iOS: `ios/DeviceKeyModule.swift` (Security, LocalAuthentication, CryptoKit)
- Android: `android/src/main/java/expo/modules/devicekey/DeviceKeyModule.kt`
  (AndroidKeyStore, `androidx.biometric` BiometricPrompt + CryptoObject)
- JS: `index.ts`, used only by `src/vault.ts` / `src/storage/nativePlatform.ts`

## What it does

| | iOS | Android |
|---|---|---|
| Local Storage Key (SQLCipher key for `vault.db`, no biometric gate) | Keychain generic password `com.loygenics.my-secrect.lsk` / `v1`, AfterFirstUnlockThisDeviceOnly, shared access group | 32 random bytes, AES-256-GCM under Keystore alias `my-secrect.lsk.v1`, `filesDir/my-secrect/lsk.bin` |
| Device-unlock key (wraps a copy of the Account Master Key) | Secure Enclave P-256 (`ios-se-p256-ecies-v1`), or a Keychain AES key when there is no Secure Enclave (`ios-kc-aesgcm-v1`, e.g. simulator); `.biometryCurrentSet`, WhenPasscodeSetThisDeviceOnly | Keystore AES-256-GCM `my-secrect.device-unlock.v1`, user auth required per use, invalidated by biometric enrolment, StrongBox when present (`android-ks-aesgcm-v1`) |

- Enrolment runs only right after a passphrase or recovery-key unlock
  (`src/vault.ts` refuses otherwise). iOS checks the new key with one
  biometric round trip before the app stores the `device_unlock` row;
  Android encrypts through the BiometricPrompt CryptoObject.
- Unlock: biometric prompt → native unwrap → the AMK goes back to JS as
  base64 → `src/vault.ts` unwraps the Vault Key and items as after a
  passphrase unlock. A wrong AMK never unlocks (the Vault Key unwrap
  fails) and the enrolment is dropped.
- A biometric enrolment change makes the key unusable → `KEY_INVALIDATED`
  → the app deletes the row and the key and asks for the passphrase.
- Errors cross the boundary only as `NOT_AVAILABLE`, `NOT_ENROLLED`,
  `KEY_INVALIDATED`, `USER_CANCEL`, `LOCKOUT`, `AUTH_FAILED`, `CORRUPT`.
  The prompt is biometric-only: no device passcode / PIN fallback.

## Limits

- The AMK crosses the JS bridge as a base64 string (contract §5 API);
  JS strings cannot be zero-filled. Native buffers are zeroed.
- The Secure Enclave path (`ios-se-p256-ecies-v1`) needs real hardware
  and has not run on a device yet; the simulator uses `ios-kc-aesgcm-v1`.
- Nothing here is audited.
