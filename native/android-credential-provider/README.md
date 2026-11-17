# Android Credential Provider — SKELETON, NOT WORKING

Android 14+ Credential Manager provider: the vault offers passkeys and
passwords in the system credential picker, and fills only the credential
the user picks, after vault unlock. Older Android needs the separate
Autofill Framework integration.

## Status — read this first

**This is NOT working Credential Manager / Autofill. Nothing here has run
in Android Studio, on a device, or in an emulator.** Phase F (17 Nov 2026)
wrote the Kotlin skeleton into this previously empty folder. Do not present
it as an installed or working provider.

| File | State |
|---|---|
| `DomainMatching.kt` | **Real, complete.** Pure origin gate (https-only, IP-literal block incl. IPv6, subdomain match, punycode-any-label confirmation). Unit-testable on the JVM without Android. Mirrors `apps/extension/src/lib/domain.ts`. |
| `VaultKeystore.kt` | **Real AndroidKeyStore code.** AES-256/GCM device key, user-authentication-required, invalidated on biometric enrolment change; wrap/unwrap helpers + encrypted-row JSON parsing. Wraps no vault key yet — there is none on this side. |
| `MySecrectCredentialProviderService.kt` | **Skeleton.** Real `CredentialProviderService` shape + request dispatch (password vs passkey, create vs get) + `rpId` extraction. Both entry points fail closed with a protocol-correct "no credential" error until the vault is wired. |
| `AndroidManifest-snippet.xml` | **Draft** service declaration — merge into the app manifest. |
| `assetlinks.json` | **Template.** Package name `com.loygenics.mysecrect`; the SHA-256 fingerprint is a `REPLACE_WITH_…` placeholder. |
| `provider-build.gradle.kts` | **Fragment** — dependency coordinates + `minSdk = 34` note. |

## What remains (Android Studio work, in order)

1. **Android project / module.** The mobile app (`apps/mobile/`) is
   Expo-managed with no `android/` folder yet. Run `npx expo prebuild`
   (or create the Android project), add the three `.kt` files under
   `com.loygenics.mysecrect.provider`, merge the manifest snippet, and
   apply the Gradle fragment (`minSdk = 34`, `androidx.credentials`
   1.3.0+ — confirm the latest version in Android Studio).
2. **Vault wiring.** The provider runs in its own process and must never
   hold the whole vault. Decide and implement ONE handoff:
   (a) the main app decrypts the single chosen item and hands it to the
   provider (short-lived, per-fill), or
   (b) a device-wrapped copy of the Vault Key (`VaultKeystore`, same shape
   as the recovery-key wrapping) lets the provider decrypt one row after
   a biometric prompt.
   Until one exists, both service entry points keep returning
   "no credential".
3. **User-selection activity.** `GetCredentialRequest` must show the
   matching logins for the user to pick (only domain-matched ones, via
   `DomainMatching`), then return exactly the picked credential.
   `CreateCredentialRequest` (passkey creation) needs the rpId, a user
   confirmation, and a vault write of the new key — not started.
4. **Passkey crypto.** ES256/EdDSA signing must happen with the vault key
   for that item only, never with the whole vault unlocked into the
   provider process.
5. **Digital Asset Links.** Host `assetlinks.json` (this file, with the
   real release SHA-256 fingerprint) at
   `https://<each-relying-party-domain>/.well-known/assetlinks.json`, and
   verify association in Android Studio / with the Statement List Tester.
   Without it the system will not invoke the provider for that domain.
6. **Autofill Framework for Android < 14** (`AutofillService`), same
   origin check and user-confirmed fill. Not started.
7. **Test on a real device (Android 14+).** Set my-secrect as the
   preferred credential provider in Settings, then sign in with a
   passkey/password in Chrome/a test app.

## Build / test (Terminal on the Mac, after step 1)

```sh
cd apps/mobile
npx expo prebuild        # generates android/ (only when the native project is wanted)
# Open android/ in Android Studio, sync Gradle, then Run on a device/emulator (API 34+)
```

No build has run. `kotlinc` alone cannot validate this service — it needs
the Android SDK and the `androidx.credentials` library.

## Security rules (do not weaken)

- Fill only on a domain-matched origin (`DomainMatching.kt`); the system
  also enforces Digital Asset Links before invoking the provider.
- Only ONE credential per user pick; never the whole vault, never a key.
- Bank / card items need explicit user confirmation before filling.
- No plaintext credentials at rest: not in SharedPreferences, not in the
  Keystore as data, not in logs.
- Biometric enrolment change invalidates the device key
  (`setInvalidatedByBiometricEnrollment(true)`); re-enrolment requires
  the passphrase.
- The React Native UI (`apps/mobile/src/`) does not fake Credential
  Manager / Autofill — there is no such button or flow in the app.

## Decisions taken in Phase F

- Package `com.loygenics.mysecrect.provider` — derived from the Tauri
  identifier `com.loygenics.my-secrect` (hyphens are illegal in Java/Kotlin
  package names, so `my-secrect` becomes `mysecrect`).
- `minSdk = 34` for the provider (Credential Manager provider service
  requires Android 14); AutofillService is the separate < 14 path.
- Protocol-correct errors (`TYPE_NO_CREDENTIAL` /
  `TYPE_NO_CREATE_CREDENTIAL`) instead of crashing or returning empty
  results — the system treats them as "this provider has nothing",
  which is the honest state today.
- Passkey signing deferred: no crypto is attempted without a vault key.
