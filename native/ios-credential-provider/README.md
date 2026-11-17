# iOS Credential Provider Extension (AutoFill, passwords)

The my-secrect app's AutoFill extension. It offers the logins whose
website matches the page, and fills **only the one login the user picks**,
after Face ID / Touch ID. It implements the provider side of the frozen
contract `specs/mobile-local-store.md` (§1–4, §6).

## Status (18 Nov 2026)

**Works end to end on the iOS 26.5 simulator, against the real app.** The
app (Debug build, Metro on 8092) created a vault, saved a login and turned
on Face ID unlock; the provider was switched on in Settings › General ›
AutoFill & Passwords, and Safari filled username + password on an https
login page through both entry points (QuickType suggestion and key icon →
my-secrect → list), each after a simulated Face ID match. Details and
screenshots: "Simulator end-to-end" below.

**Not tested on a physical device** (no paid Apple Developer team here;
see the last section). The Secure Enclave scheme `ios-se-p256-ecies-v1`
therefore only has its blob format unit-tested (software P-256 key); the
simulator uses `ios-kc-aesgcm-v1`. Passkeys are not implemented: the
provider offers and fills passwords only.

## Layout

| Path | What |
|---|---|
| `Sources/AutoFillCore/` | Shared core, compiled into the extension and tested by `swift test`. |
| `Sources/AutoFillCore/VaultDatabase.swift` | `vault.db` (SQLCipher 4, raw 32-byte LSK) read side, `query_only`; LSK from the keychain. |
| `Sources/AutoFillCore/VaultCrypto.swift` | XChaCha20-Poly1305 IETF (libsodium) and the key chain AMK → Vault Key → Item Key → row. |
| `Sources/AutoFillCore/DeviceUnlock.swift` | Biometric AMK release for `ios-se-p256-ecies-v1` and `ios-kc-aesgcm-v1`; contract §4 error codes. |
| `Sources/AutoFillCore/CredentialFill.swift` | Decrypts ONE row, checks it is a live v1 login with a password whose own URL matches the page. |
| `Sources/AutoFillCore/AutoFillMatching.swift` | `DomainMatching` applied to AutoFill service identifiers; `ASCredentialIdentityStore` sync. |
| `Sources/AutoFillCore/DomainMatching.swift` | Anti-phishing gate, mirror of `apps/extension/src/lib/domain.ts`. |
| `Sources/AutoFillCore/SecretBytes.swift` | Wiped buffers for keys and plaintext. |
| `Sources/AutoFillCore/DevVaultWriter.swift` | `#if DEBUG` only: writes a contract-layout `vault.db` for the tests. |
| `Extension/` | `ASCredentialProviderViewController`, list / message / configuration UI, `Info.plist`, entitlements. |
| `tests/` | XCTest suite, the TypeScript fixture generator and its output. |
| `Package.swift` | Test harness; pins the same Swift packages as the Expo plugin. |

The Xcode target is generated, not committed: the Expo config plugin
`apps/mobile/plugins/with-ios-credential-provider.js` adds it on
`npx expo prebuild`.

## Fill path (contract §6)

1. `prepareCredentialList(for:)`: LSK from the keychain (service
   `com.loygenics.my-secrect.lsk`, account `v1`, group
   `$(AppIdentifierPrefix)com.loygenics.my-secrect.shared`) → open
   `<App Group>/Library/Application Support/my-secrect/vault.db`
   (`meta.schema_version` must be `1`) → `autofill_index` → logins whose
   host passes `DomainMatching` for the page (https only, no IP literals,
   exact or subdomain match, punycode needs a confirmation tap). Passkey
   entries are never offered for a password fill. The user picks one.
2. `device_unlock` row missing → "Open my-secrect and enable biometric
   unlock", then the request is cancelled (`ASExtensionError.failed`).
3. Face ID / Touch ID (`LAContext`, biometrics only, no passcode
   fallback; started from `viewDidAppear`, because LocalAuthentication
   refuses an extension that is not on screen yet) → the evaluated
   context releases the AMK:
   - `ios-kc-aesgcm-v1`: generic password `com.loygenics.my-secrect.device-unlock` / `v1`
     → AES-GCM open of `wrapped_amk` (`nonce 12 ‖ ct ‖ tag 16`);
   - `ios-se-p256-ecies-v1`: SE key tag `com.loygenics.my-secrect.device-unlock.v1`
     → `SecKeyCreateDecryptedData(.eciesEncryptionCofactorVariableIVX963SHA256AESGCM)`.
   → Vault Key (`vault_keys.json` `wrapped_vault` / `wrapped_vault_nonce`)
   → Item Key (`wrapped_item_key` / `wrapped_nonce`) → that row
   (`nonce` / `ciphertext`). The decrypted item must have the row's id,
   `schema_version` 1, type `login`, a non-empty password, and a `url`
   whose host matches the page — so a tampered `autofill_index` cannot
   send a password to another site. Trashed rows (`deleted_at`) are refused.
4. `completeRequest(withSelectedCredential: ASPasswordCredential(user, password))`.
   AMK, Vault Key, Item Key, LSK and the plaintext JSON live in
   `SecretBytes` and are zeroed (`sodium_memzero`) before returning.
   Not zeroable: the keychain's own `CFData` copies and the `String`s
   handed to `ASPasswordCredential`.

Errors: user cancel → `.userCanceled`; missing / trashed / non-login
row → `.credentialIdentityNotFound`; everything else (decryption, parse,
auth, key invalidated, lockout, domain mismatch) → `.failed`, after a
short message. Quick fill without UI always answers
`.userInteractionRequired`, because every fill needs biometrics; iOS
then calls `prepareInterfaceToProvideCredential(for:)`, which re-runs
the domain gate against the index entry before unlocking. No path
returns an empty or made-up credential.

## Credential identity store (QuickType suggestions)

`CredentialIdentitySync` replaces the system's identities with the
`autofill_index` logins (host as a `.domain` identifier, username,
item id). The extension calls it when the configuration screen opens
and on every credential list; if the store cannot be opened it removes
all identities.

**The app should also call it** (app side, not built here): after every
`autofill_index` rewrite (unlock, item write), `replaceCredentialIdentities`
with the same rows; on wipe and when biometric unlock is disabled (the
two moments the app clears `autofill_index`, spec §8.2),
`removeAllCredentialIdentities`. Today only the extension syncs, so a
login saved in the app shows up as a QuickType suggestion only after the
provider has run once (configuration screen or key-icon list); the
key-icon list itself always reads the live index. The simplest app-side
route is for `apps/mobile/modules/device-key` to compile
`Sources/AutoFillCore/AutoFillMatching.swift` and call
`CredentialIdentitySync.replaceAll(with:)` / `removeAll()`.

## Associated Domains

None, on purpose. A password provider fills any site that passes the
domain gate; Associated Domains are not involved. The old
`webcredentials:TODO-REPLACE-WITH-YOUR-DOMAIN` placeholder is gone.

If the app ever needs `webcredentials:` for a domain of its own (e.g. a
web sign-in for the my-secrect service), set it at build time:

```sh
MY_SECRECT_WEBCREDENTIALS_DOMAINS="example.org,login.example.org" npx expo prebuild --platform ios
```

The plugin then adds `webcredentials:<domain>` to the **app** target.
Each domain must serve `/.well-known/apple-app-site-association` listing
`<TEAMID>.com.loygenics.my-secrect`, which needs a paid Apple Developer team.

## Build and test

```sh
# Unit tests (macOS host, ~1 s after the first build)
cd native/ios-credential-provider && swift test

# Same suite on an iOS simulator
cd native/ios-credential-provider && xcodebuild test -scheme AutoFillCore \
  -destination 'platform=iOS Simulator,name=<simulator>'

# Regenerate the fixture with the real TypeScript crypto (repo root)
npx tsx native/ios-credential-provider/tests/generate-fixtures.ts

# App + extension (ios/ is generated and gitignored)
cd apps/mobile
LANG=en_US.UTF-8 npx expo prebuild --platform ios
xcodebuild -workspace ios/mysecrect.xcworkspace -scheme mysecrect \
  -configuration Debug -destination 'id=<simulator-udid>' build
```

What the plugin adds on prebuild: the `CredentialProvider` app-extension
target (bundle id `com.loygenics.my-secrect.CredentialProvider`) compiling
`Sources/AutoFillCore/*.swift` + `Extension/*.swift` in place; Swift
packages swift-sodium 0.11.0 (`Clibsodium`, static) and SQLCipher.swift
4.20.0 (`SQLCipher.framework`, dynamic) for the extension only;
"Embed Foundation Extensions" and "Embed Frameworks (CredentialProvider)"
(SQLCipher.framework goes into the **app's** `Frameworks/`, because an
app extension may not carry its own `Frameworks/` folder); and the AutoFill
entitlement on the app target as well. App Group, keychain group and
`MySecrectKeychainAccessGroup` for the app come from `with-mobile-storage.js`.

Build notes from this machine (Xcode 26.6, CocoaPods 1.16.2):

- `pod install` fails under Ruby json 3.x (`unknown keyword: quirks_mode`
  from React Native's Podfile helpers). Workaround used here, from
  `apps/mobile/ios` after `npx expo prebuild --platform ios --no-install`:
  `LANG=en_US.UTF-8 ruby -e 'gem "json", "< 3"; gem "cocoapods", "1.16.2"; load Gem.bin_path("cocoapods", "pod", "1.16.2")' install`.
- The pre-existing CocoaPods warning about an unknown UUID in the app's
  Resources phase comes from Expo's template (bridging header), not from
  this plugin; it appears without the plugin too.

## Simulator end-to-end

Run on 18 Nov 2026 on simulator `a11-iphone` (iPhone 15, iOS 26.5),
Debug build, Metro on port 8092 (`RCT_jsLocation` = `localhost:8092`):

1. `xcrun simctl erase`, boot, enrol Face ID
   (`notifyutil -s/-p com.apple.BiometricKit.enrollmentChanged`).
2. Install the app; in the app: create a vault, save a login
   (`https://the-internet.herokuapp.com/login`, the site's public demo
   credentials), unlock again and accept "Turn on Face ID unlock"
   (`notifyutil -p com.apple.BiometricKit_Sim.pearl.match`). The app wrote
   an encrypted `vault.db` into the App Group container.
3. Settings › General › AutoFill & Passwords lists "my-secrect —
   Passwords"; switching it on shows the configuration screen:
   "AutoFill is ready: 1 logins can be offered" (the extension opened the
   app's `vault.db` with the LSK from the shared keychain and found the
   `device_unlock` row).
4. Safari → the login page → focus the password field → QuickType
   "password for this website — my-secrect / tomsmith" → the extension
   shows "Unlocking…" and the Face ID sheet → match → username and
   password filled.
5. Reload → key icon → "my-secrect" → list "Logins for
   the-internet.herokuapp.com" → pick → Face ID → match → filled.
   The form was never submitted.

Two things this run found and fixed: Settings does not list a provider
whose containing app lacks the AutoFill entitlement (the plugin now adds
it to the app), and LocalAuthentication fails with "Caller is not running
foreground" when the prompt starts before the extension's view is on
screen (the prompt now waits for `viewDidAppear`). In both cases the
extension had failed closed (`AUTH_FAILED`, no credential).

Simulator-only shortcuts: Face ID is simulated with `notifyutil`; the
simulator has no Secure Enclave, so the app enrolled `ios-kc-aesgcm-v1`.

## What needs a paid Apple Developer team or a real device

- **Any physical device run.** Installing on an iPhone needs a signing
  team whose provisioning profiles include the App Group
  `group.com.loygenics.my-secrect`, the shared keychain group and the
  AutoFill Credential Provider capability for both
  `com.loygenics.my-secrect` and `com.loygenics.my-secrect.CredentialProvider`.
  App Groups need an explicit App ID registered in the developer portal
  (paid membership); a free personal team cannot register these.
  The simulator accepts the same entitlements unsigned ("simulated
  entitlements"), which is why everything above ran without a team.
- **The Secure Enclave scheme** (`ios-se-p256-ecies-v1`) end to end:
  the simulator has no Secure Enclave. Only the blob format is tested.
- **Associated Domains**, only if ever wanted: the domain must serve
  `apple-app-site-association` naming `<TEAMID>.com.loygenics.my-secrect`,
  which needs a real team ID.
- **App Store distribution**: SQLCipher.framework lives in the app's
  `Frameworks/` on purpose (validation rejects an `.appex/Frameworks/`);
  this was not validated against App Store Connect.

## Security rules (do not weaken)

- Fill only on a domain-matched https origin, checked twice: index host
  before unlock, decrypted item URL after.
- One credential per user pick; never the whole vault, never a key.
- No plaintext credential at rest: not in the App Group, not in the
  keychain, not in logs. `autofill_index` holds titles, usernames and
  hosts only.
- The provider never writes to `vault.db` (its connection is `query_only`).
- Biometric enrolment change invalidates the device-unlock key
  (`.biometryCurrentSet`); the provider then fails with a message and the
  app must re-enrol after a passphrase unlock.
