# Keychain (iOS) / Keystore (Android) — PLANNED, not implemented

## Goal
Device-protected quick unlock: wrap a copy of the Account Master Key
(or a Vault-Key-wrapping key) with a key held in the Secure Enclave /
StrongBox, gated by biometrics, so Face ID / fingerprint can unlock
the vault without typing the passphrase every time.

## What exists today
- `expo-local-authentication` presence check only (LockScreen).
  It proves the user is present; it does NOT derive or unwrap any
  vault key. The app says this on the lock screen.
- The vault key hierarchy already supports this: a new wrapping of
  the Account Master Key under a device-protected KEK is exactly the
  same shape as the recovery-key wrapping in `src/vault.ts`
  (`wrapped_recovery` / `wrapped_recovery_nonce`).

## What is needed (native work, Xcode / Android Studio)
- iOS: `Security` framework / Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
  + `SecAccessControl` (`biometryCurrentSet`), key in Secure Enclave
  (`kSecAttrTokenIDSecureEnclave`) where available.
- Android: `AndroidKeyStore` AES/GCM key with
  `setUserAuthenticationRequired(true)` + `setInvalidatedByBiometricEnrollment(true)`.
- A small native module (or `expo-secure-store` as a first step —
  note it is NOT Secure Enclave / StrongBox by itself) exposing
  `wrapWithDeviceKey(bytes)` / `unwrapWithDeviceKey(bytes)`.
- Enrolment flow: only after a successful passphrase unlock, offer
  "Enable Face ID unlock", generate the device key, wrap the Master
  Key, store the wrap next to `wrapped_recovery`. Revocation: delete
  the device wrap on "Disable" and on biometric enrolment change.

## Explicitly NOT done
No device key is generated, no Master Key copy is wrapped by any
device key, and no biometric unlock path bypasses the passphrase
in this build. Do not claim otherwise.

## Phase F update (17 Nov 2026)
Still PLANNED, not implemented — nothing above changed: biometrics
remain presence-only (see `src/screens/LockScreen.tsx`, which says so
on screen). New scaffolding this plan now points at (also NOT working):
- iOS: `native/ios-credential-provider/VaultStore.swift` (`DeviceKeyStore`
  — real Keychain code for a future 32-byte device wrapping key,
  biometry-gated, device-only; it stores no vault key and wraps nothing
  yet) + `native/ios-credential-provider/README.md`.
- Android: `native/android-credential-provider/VaultKeystore.kt` (real
  AndroidKeyStore AES-256/GCM device key, user-auth-required, invalidated
  on enrolment change; it wraps nothing yet) +
  `native/android-credential-provider/README.md`.
The enrolment flow above is still the design; the device-key generation
+ Master Key wrapping step has not been built.
