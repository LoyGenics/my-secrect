# Mobile — React Native (Expo)

Local-first E2EE vault for iOS + Android. Same crypto and key hierarchy
as the desktop app (`../desktop/src/vault.ts`):

```
passphrase --Argon2id--> KEK --wrap--> Account Master Key (32B)
  --wrap--> Vault Key (32B) --wrap--> per-item Item Key (32B)
  Item Key --XChaCha20-Poly1305 (fresh 24B nonce)--> VaultItem JSON
```

Recovery key (32 random bytes, base64url, shown once) is SHA-256-hashed
to a recovery KEK that also wraps the Master Key. Lose both passphrase
and recovery key = lose the vault. No server copy, no reset.

## Screens (all working, no stubs)

- **Onboarding** — create passphrase (strength meter, mismatch validation) → recovery key shown once + copy + confirm checkbox → done.
- **Lock** — passphrase, recovery key, Face ID / fingerprint once turned on (see below).
- **Vault tab** — All / Favorites / Trash / 8 categories / tags, item list, + New, load/clear example data (fake values only).
- **Search tab** — instant local search (title, tags, fields); the query never leaves the device.
- **Generate tab** — password generator (length 12–32, symbols/numbers/uppercase, pronounceable) + passphrase generator + strength.
- **Health tab** — score 0–100, weak passwords, reused passwords, cards/documents expiring in 30 days; tap an item to fix it.
- **Settings tab** — change passphrase (re-wraps the same Master Key, items untouched, recovery key still works), auto-lock (1/5/15 min/never), recovery info, lock now, view Trash, encrypted export, plaintext export (two-tap confirm + warning), wipe vault (Alert + arm confirm).
- **Item Detail** — every field with show/hide + copy, live TOTP (pure-TS RFC 6238, 30 s), tags, related items (tap to open), favorite, edit, trash/restore, permanent delete.
- **Item Form** — all 12 item types across the 8 modules, custom fields, relations picker, tags and favorites. Cards accept a full number and an optional CVV encrypted on the device.
- **Trash** — restore / permanently delete.

Bottom tab bar: Vault / Search / Generate / Health / Settings. Every
input has a visible label, `accessibilityLabel` and `testID`.

## Import items

In **Settings → Import items**, download the My Secret CSV template through
the iOS share sheet or the Android folder picker. You can also pick a login
CSV exported by 1Password, Bitwarden or Google Password Manager. The app
parses the CSV locally and writes only the selected items to the encrypted vault.

Text import uses the account server after the user explicitly agrees to
send the pasted text to OpenAI. Rebuild the native app to include the
`ImportTransport` module. The same server configuration as web enables AI
preview.

## Storage

Contract: `specs/mobile-local-store.md`. `vault.db` is SQLite encrypted
with SQLCipher 4 (`expo-sqlite`, `useSQLCipher` in `app.json`), keyed
with the device Local Storage Key (LSK) from `modules/device-key`:

- iOS: App Group `group.com.loygenics.my-secrect` container,
  `Library/Application Support/my-secrect/vault.db`; LSK in the shared
  keychain access group (`plugins/with-mobile-storage.js` adds both
  entitlements).
- Android: `filesDir/my-secrect/vault.db`; LSK wrapped by an
  AndroidKeyStore AES-GCM key in `filesDir/my-secrect/lsk.bin`.

It holds the same encrypted rows and wrapped-key JSON the AsyncStorage
build kept, plus `device_unlock` and `autofill_index` (titles,
usernames, hosts of login/passkey items — never secrets) for the
credential providers. The index exists only while biometric unlock is
on: turning it off, an invalidated key, a passphrase change and wipe
all clear it. `src/storage/` has the schema, transactions and
migration; `src/storage/nativePlatform.ts` opens the real database and
refuses to run if SQLCipher is not linked. Every multi-row write is one
transaction.

**Migration:** the first launch of this build copies the AsyncStorage
keys `my-secrect.local-vault.v1(.keys)` into `vault.db` in one
transaction, checks the row count, then deletes those two keys. If
anything is unreadable the copy is rolled back, AsyncStorage is left
as is, and the lock screen shows the error; no row is dropped.

Media/documents store metadata + encrypted blob manifest + SHA-256;
file bytes are **not** stored in this build (labelled in the UI).

## Biometric unlock

Real device-protected unlock (contract §4), not a presence check:

- After a passphrase or recovery-key unlock, the lock screen offers
  "Turn on Face ID / fingerprint unlock". Settings can turn it on too,
  after the passphrase is entered again. A copy of the Account Master
  Key is wrapped by a biometric-gated device key — Secure Enclave
  P-256 ECIES (`ios-se-p256-ecies-v1`), a Keychain AES-GCM key when
  there is no Secure Enclave such as the simulator (`ios-kc-aesgcm-v1`),
  or an AndroidKeyStore AES-GCM key used through `BiometricPrompt`
  `CryptoObject` (`android-ks-aesgcm-v1`). The wrap is stored in
  `device_unlock`; the plaintext Master Key never touches disk.
- Biometric unlock releases the Master Key, which then unwraps the
  Vault Key and items exactly as after a passphrase unlock.
- Changing enrolled faces / fingerprints invalidates the device key.
  The app deletes the `device_unlock` row, says so, and asks for the
  passphrase. Cancel, no match and lockout only ever fall back to the
  passphrase — never to the device passcode.
- Turning it off, wiping the vault and changing the passphrase delete
  the device key and the row.
- Signing out, deleting the account, changing the server and a server 401
  (revoked or invalid session) also delete the row, the device key and the
  autofill index (`signOutVault`). A session that only expired locally
  returns to sign-in and keeps them. The encrypted vault stays; sign in and enter the
  passphrase to open it again.
- Auto-lock also applies when the app comes back from the background.

## Account sign-in

An account session comes before creating, unlocking or restoring a vault.
The sign-in screen offers Sign in with Apple (iOS), Sign in with Google and
the email code. A button appears only when `GET /v1/auth/providers` returns
that provider with this platform's ID (`apple.bundle_id`,
`google.ios_client_id` / `google.android_client_id`). A session with a known,
unexpired expiry may open the vault offline; one without a stored expiry is
checked online first.

Google uses `expo-auth-session` (authorization code + PKCE in the system
browser, with the nonce). Console setup the owner does once:

- iOS OAuth client for bundle `com.loygenics.my-secrect`. Its redirect is the
  reversed client ID (`com.googleusercontent.apps.<id>:/oauthredirect`).
- Android OAuth client for package `com.loygenics.mysecrect` and the signing
  certificate SHA-1. Under **Advanced settings**, turn on **Enable custom URI
  scheme**: the redirect is `com.loygenics.mysecrect:/oauthredirect`, and
  Google blocks custom schemes for Android clients by default.
- Apple: enable Sign in with Apple for the App ID (`ios.usesAppleSignIn` adds
  the entitlement at prebuild).

## Native integrations — implemented vs planned

| Integration | Status |
|---|---|
| Face ID / Touch ID / Android biometric unlock (Master Key wrap) | Implemented in `modules/device-key` (Swift + Kotlin) |
| Keychain (iOS) / Keystore (Android) key wrapping | Implemented — see `native/keychain-keystore/README.md` |
| iOS Credential Provider Extension (AutoFill) | Planned — see `native/ios-credential-provider/README.md` |
| Android Credential Manager (Android 14+) | Planned — see `native/android-credential-manager/README.md` |
| Encrypted SQLite (SQLCipher) | Implemented — `vault.db`, see Storage |
| Sync with Rails API | Not built — local-only, like desktop Phase 1 |

## Run

SQLCipher and the DeviceKey module are native code, so Expo Go cannot
run this app; use a development build.

```bash
cd apps/mobile
npm install
npx expo prebuild                 # generates ios/ and android/ (gitignored)
npx expo run:ios                  # simulator; needs Xcode + CocoaPods
npx expo run:android              # emulator; needs Android SDK + JDK 17
```

Tests that run off-device (real SQLite via sql.js, real vault crypto):

```bash
npx tsx --test apps/mobile/tests/vault-store.test.ts
npx tsx --test apps/mobile/tests/vault-device-unlock.test.ts
npx tsx --test apps/mobile/vault-restore.test.ts
npx tsx --test apps/mobile/tests/libsodium-shim.test.ts
```

`vault-device-unlock.test.ts` drives `src/vault.ts` with a software
stand-in for the native DeviceKey module; the Swift and Kotlin code is
only exercised on a simulator / emulator.

Build notes (SDK 52, checked with Xcode 26.6 and the Android SDK):
- libsodium runs natively. Hermes has no WebAssembly, and
  libsodium-wrappers' asm.js fallback is broken there (repeated "random"
  bytes, AEAD that does not round-trip). `metro.config.js` resolves
  `libsodium-wrappers-sumo` on iOS/Android to
  `src/crypto/libsodium-react-native.ts`, a shim over
  `react-native-libsodium` (JSI). It copies subarray views (the binding
  reads `.buffer`), computes HMAC-SHA256 with native HKDF-Extract and
  SHA-256 with `@noble/hashes` (no native binding for it). The binding
  takes AEAD additional data only as a string: 7-bit AD works, AD with
  bytes >= 0x80 (some item-v2 cases) fails closed. v1 uses no AD.
- `index.js` imports `polyfills.js` first: `expo-crypto` provides
  `crypto.getRandomValues` (Hermes has no Web Crypto).
- Dev-only crypto check: `EXPO_PUBLIC_CRYPTO_CHECK=1 npx expo start`
  mounts `dev/CryptoCheck.tsx` instead of the app. It runs the
  `tests/crypto-vectors/*.json` found in this checkout plus the libsodium
  self-test on the device, and can restore a desktop-made backup put in
  `dev/fixtures/` (ignored by git). Release bundles do not include it.
- `plugins/with-mobile-storage.js` builds the `fmt` pod as C++17
  (fmt 11 + Xcode 26 clang fail as C++20).
- If `pod install` fails with `unknown keyword: quirks_mode`, the
  `json` gem is 3.x; run CocoaPods with json 2.9:
  `ruby -e 'gem "json", "2.9.0"; load Gem.bin_path("cocoapods", "pod")' install`.
- `app.json` currently sets no icon (no placeholder is shipped).
  Add a 1024×1024 icon at `assets/icon.png` and reference it in
  `app.json` before a store build — do not ship with a blank icon.

## Not audited

No part of this codebase is claimed audited or production-ready.
Do not store sole-copy live secrets here until the crypto-core,
sync and native steps have been reviewed and tested on device.
