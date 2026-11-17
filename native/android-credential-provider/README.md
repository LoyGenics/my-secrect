# Android Credential Provider

Android 14+ (API 34+) Credential Manager provider for **passwords**. It
lists matching my-secrect logins in the system credential sheet and,
after a BiometricPrompt, returns the one login the user picked. It reads
the vault the app writes (`specs/mobile-local-store.md`) and never
writes to it.

## Status

| Piece | State |
|---|---|
| Password fill (get) | **Working on an emulator** — see "Verified" below. |
| Passkeys (get / create) | **Not implemented.** Not declared in the provider capabilities, so the system never asks for them. Index entries of type `passkey` are ignored. |
| Saving / creating passwords | **Refused** (`CreateCredentialNoCreateOptionException`). The contract forbids the provider from writing `rows` / `vault_keys`; saving needs the app. |
| Android 9–13 (Autofill Framework) | **Not implemented.** The service and activity are disabled below API 34 (`values-v34` bool), so older devices get nothing from my-secrect — no fallback, no fake. |
| Physical device | **Not tested.** Emulator only. |

## Layout

```
src/main/kotlin/…/provider/   provider code (copied to android/app/src/main/kotlin by the config plugin)
src/main/res/                 provider capabilities, strings (en, vi), Chrome allowlist, API 34 enable flag
src/debug/kotlin/             AssetLinksOverride — DEBUG ONLY local assetlinks.json for the emulator test
src/release/kotlin/           AssetLinksOverride — always null
src/test/kotlin/              JVM tests (DomainMatching, AssetLinks)
src/androidTest/kotlin/       instrumented tests + opt-in E2ESeed
fixtures/generate-fixture.ts  builds a test vault with packages/crypto-adapters, as vault.ts does
e2e-caller/                   tiny stand-in third-party app that calls CredentialManager.getCredential
assetlinks.json               template for the my-secrect web domain (no fingerprint filled in)
```

`apps/mobile/plugins/with-android-credential-provider.js` (registered in
`apps/mobile/app.json`) puts all of this into the generated project on
`npx expo prebuild`: Kotlin into `src/<set>/kotlin` (prebuild's package
rename only scans `src/<set>/java`), the service + activity + a launcher
`<queries>` entry into the manifest, and the Gradle dependencies
(`androidx.credentials:credentials:1.5.0`, `androidx.biometric:biometric:1.1.0`,
`net.zetetic:sqlcipher-android:4.6.1`, `net.java.dev.jna:jna:5.14.0`, test deps).
libsodium is the app's own `libsodium.so` from react-native-libsodium,
reached through JNA (`Libsodium.kt`) so the APK has a single copy.

## Fill path (contract §6)

1. **Begin** (`MySecrectCredentialProviderService.onBeginGetCredentialRequest`):
   for a `BeginGetPasswordOption`, open `vault.db` read-only (SQLCipher,
   LSK from `lsk.bin` via Keystore `my-secrect.lsk.v1`), read the `login`
   rows of `autofill_index`, keep those allowed for the caller
   (`CallerMatcher`), and return one `PasswordCredentialEntry` per login
   (title + username only). No vault secret is touched. No vault → empty
   response.
2. **Pick** (`GetPasswordActivity`): re-check that the picked id is in the
   index, is a login and is allowed for this caller (the PendingIntent is
   mutable, so its extra is never trusted alone); require the
   `device_unlock` row (missing → `NoCredentialException`, "Open my-secrect
   and enable biometric unlock"); arm an AES-GCM decrypt cipher with
   Keystore `my-secrect.device-unlock.v1` (missing / invalidated key →
   `NoCredentialException`).
3. **Unlock**: BiometricPrompt (BIOMETRIC_STRONG) with that cipher as the
   CryptoObject → AMK → Vault Key (`wrapped_vault`) → Item Key → that one
   row → `PasswordCredential(username, password)`. The decrypted item id
   must equal the row id; trashed rows, non-logins and logins without a
   password are refused.
4. AMK, Vault Key, Item Key and plaintext buffers are zeroed. Username and
   password are Java Strings (the `PasswordCredential` API) and cannot be
   zeroed. Nothing is cached or logged.

Every failure ends in a `GetCredentialException`: user cancel →
`GetCredentialCancellationException`; no match / not enrolled / key
invalidated → `NoCredentialException`; lockout / auth failure / corrupt
data / missing native library → `GetCredentialUnknownException`. The
activity shows a toast for the non-cancel cases.

## Who may get which login (`CallerMatcher`)

- **Privileged browsers**: if the caller set an origin, it must be an
  allowlisted browser (`res/raw/my_secrect_privileged_browsers.json`:
  Chrome stable only, fingerprint read from the Chrome APK). The origin
  then goes through `DomainMatching.checkFillAllowed`.
- **Apps**: Digital Asset Links in both directions. The calling app's
  manifest `asset_statements` must name the site, and that site's
  `https://<host>/.well-known/assetlinks.json` must grant
  `delegate_permission/common.get_login_creds` to the app's package and
  current signing certificate. Only sites the app itself declares are
  fetched (HTTPS, no redirects, 2 s timeouts, 128 KB cap, 5 min in-memory
  cache), so a request never reveals the vault's other hosts. `include`
  statements inside a site's file are not followed (fail closed).
- Only `FillDecision.Allowed` passes: punycode hosts and bank/card types
  are not offered (there is no confirmation UI in the provider).

## Verified (emulator only)

Emulator `a12-cred-api37`: Pixel 7 profile, Android 17 (API 37) Google
Play image, arm64, PIN + one enrolled virtual fingerprint.

- JVM: `./gradlew :app:testDebugUnitTest` → 21 tests, 0 failures
  (`DomainMatchingTest` 11, `AssetLinksTest` 10).
- Instrumented (`adb shell am instrument -w -e class …VaultCryptoTest,…VaultStoreTest,…E2ESeed
  com.loygenics.mysecrect.test/androidx.test.runner.AndroidJUnitRunner`) on the
  build merged with the mobile storage work → 21 tests: 20 passed, 1
  skipped (E2ESeed is opt-in). Covers the shared AEAD and Argon2id vectors
  against the app's libsodium, the TS fixture decrypting to the expected
  credential, wrong AMK, tampered ciphertext / item key, swapped payload,
  non-login / no password / trashed, contract-shaped SQLCipher `vault.db`,
  wrong LSK (database left intact), missing LSK, missing `device_unlock`,
  missing device-unlock key, malformed blob, and a contract device-unlock
  key refusing to open the AMK without a BiometricPrompt.
- End-to-end against the real app (debug build of main + this provider,
  JS from Metro): created a vault in the app, added a login
  (`https://example.com/login`, `alice@example.com`), turned on fingerprint
  unlock in the app (DeviceKey wrote `device_unlock`), wrote the
  debug-only assetlinks override for example.com naming `e2e-caller`,
  turned on my-secrect under Settings › Passwords & passkeys ›
  Additional services. Then `e2e-caller` → `CredentialManager.getCredential(GetPasswordOption)`:
  1. the system sheet listed "alice@example.com · Example login" from
     my-secrect;
  2. Continue → `GetPasswordActivity` → BiometricPrompt (secure window,
     screenshots are black) → `adb emu finger touch 1`;
  3. the caller received `PasswordCredential(id=alice@example.com,
     password=<the password typed in the app>)`.
  Negative runs on the same setup: back on the prompt →
  `GetCredentialCancellationException (TYPE_USER_CANCELED)`; override
  removed (so the real HTTPS fetch of example.com's assetlinks.json ran
  and granted nothing) → my-secrect offered nothing →
  `NoCredentialException`.

Not verified: a physical device, Android 14/15/16 images, Chrome or any
browser as the caller, a site whose real assetlinks.json grants an app
(no such domain was available), biometric re-enrolment invalidation.

## Run it

```sh
npm ci
cd apps/mobile && npx expo prebuild --platform android      # android/ is gitignored
cd ../.. && npx tsx native/android-credential-provider/fixtures/generate-fixture.ts
cd apps/mobile/android
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
adb install -t app/build/outputs/apk/debug/app-debug.apk
adb install -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e package com.loygenics.mysecrect.provider \
  com.loygenics.mysecrect.test/androidx.test.runner.AndroidJUnitRunner
```

The device needs a secure lock screen and an enrolled fingerprint for the
device-unlock key test (`adb emu finger touch 1` on an emulator).

Emulator end-to-end:

1. Build and install `e2e-caller`:
   `apps/mobile/android/gradlew -p native/android-credential-provider/e2e-caller assembleDebug`.
   Its certificate SHA-256: `apksigner verify --print-certs <apk>`.
2. Give the debug app a vault: either use the app (create a vault, add a
   login for `https://example.com`, turn on biometric unlock), or seed the
   fixture with
   `adb shell am instrument -w -e class com.loygenics.mysecrect.provider.E2ESeed -e e2eSeed true -e callerCert <sha256> com.loygenics.mysecrect.test/androidx.test.runner.AndroidJUnitRunner`
   and touch the sensor when the prompt shows.
3. Debug-only DAL override (E2ESeed writes it; with a vault made in the
   app write it yourself):
   `files/my-secrect-debug/assetlinks/example.com.json` inside the app
   (`adb shell run-as com.loygenics.mysecrect …`) granting
   `get_login_creds` to `com.loygenics.mysecrect.credtest` + its cert.
4. Settings › Passwords, passkeys & accounts → turn on my-secrect.
5. Open "my-secrect credtest" → Get password → pick the my-secrect login
   → touch the sensor → the caller shows the returned credential.

## Release checklist (needs Play Console / signing / a device)

- **Physical Android 14+ device** test, including biometric re-enrolment
  (key invalidation) and lockout.
- **Privileged browser allowlist**: ship Google's maintained list
  (`https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json`) or
  at least the browsers you support; today only Chrome stable is listed.
- **`assetlinks.json`** (this folder) is only for the my-secrect web
  domain, if the app should share sign-in with it. Fill
  `sha256_cert_fingerprints` with the Play App Signing certificate SHA-256
  (Play Console › Setup › App integrity) and, if you sideload, the upload
  key (`keytool -list -v -keystore <release.jks>`); host it at
  `https://<my-secrect domain>/.well-known/assetlinks.json`. The provider
  itself needs no assetlinks file; relying parties publish their own.
- **Package visibility**: the launcher `<queries>` entry is needed to read
  callers' `asset_statements`; mention it in the Play package-visibility
  declaration if asked.
- **Passkeys** and **Autofill Framework for Android < 14** remain to be
  built; until then they are absent, not faked.
