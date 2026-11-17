# iOS Credential Provider Extension — SKELETON, NOT WORKING

System AutoFill in Safari and other apps: the vault offers logins /
passkeys for the current app/website, and fills only the credential
the user picks, after vault unlock.

## Status — read this first

**This is NOT working AutoFill. Nothing here has run in Xcode, on a
device, or in a simulator.** Phase F (17 Nov 2026) wrote the Swift
skeleton into this previously empty folder. Do not present it as an
installed or working provider.

| File | State |
|---|---|
| `DomainMatching.swift` | **Real, complete.** Pure domain/origin gate (https-only, IP-literal block incl. IPv6, subdomain match, punycode-any-label confirmation). Unit-testable without Xcode wiring. Mirrors `apps/extension/src/lib/domain.ts`. |
| `VaultStore.swift` (rows + metadata parsing) | **Real code, no data yet.** Parses the encrypted rows and the metadata index from the App Group container. Today the main app writes neither file, so these throw `.storeUnavailable`. |
| `VaultStore.swift` (`DeviceKeyStore`) | **Real Security-framework code.** Biometrics-gated (`biometryCurrentSet`), device-only Keychain storage of a random 32-byte device wrapping key. Stores no vault key and performs no wrapping yet. |
| `VaultStore.credential(for:)` | **Explicitly NOT implemented** — `fatalError("not implemented")`. Decryption needs the Vault Key, which the extension does not have. |
| `CredentialProviderViewController.swift` | **Skeleton.** Real system callbacks + picker UI, but every fill path funnels into the `fatalError` above. |
| `CredentialProvider.entitlements` | **Draft.** App Group `group.com.loygenics.my-secrect` + AutoFill provider flag are real; Associated Domains still has a `TODO-REPLACE-WITH-YOUR-DOMAIN` placeholder. |
| `Info.plist` | **Draft** extension plist (`com.apple.authentication-services.credential-provider`). |

## What remains (Xcode work, in order)

1. **Xcode project / target.** The React Native app (`apps/mobile/`) is
   Expo-managed with no `ios/` folder yet. Run `npx expo prebuild` (or
   create the Xcode project), then add an App Extension target of type
   Credential Provider, bundle id
   `com.loygenics.my-secrect.CredentialProvider`, and add the three
   `.swift` files + `Info.plist` + entitlements to it.
2. **App Group.** Enable `group.com.loygenics.my-secrect` for the App ID
   in the Apple Developer portal, add the group to BOTH the main app
   target and the extension target (same entitlements file content for
   the group entry), and confirm
   `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`
   resolves in both.
3. **Main-app sharing.** After a successful passphrase unlock, the main
   app writes into the App Group container under
   `Library/Application Support/my-secrect/`:
   - `vault-rows.json` — the encrypted rows (same shape as the desktop
     vault: `id, revision, nonce, ciphertext, wrapped_item_key,
     wrapped_nonce, deleted_at`).
   - `vault-metadata.json` — `[{id, title, username, host, type}]` for
     login/passkey items only. Titles/usernames/hosts ONLY — never
     passwords, never keys, never ciphertext.
   The extension reads these; it never writes credentials anywhere.
4. **Unlock handoff (the hard part).** Decide and implement ONE:
   (a) the main app decrypts the single chosen item and hands the
   plaintext credential to the extension via the shared container
   (short-lived, deleted immediately after the fill), or
   (b) a device-wrapped copy of the Vault Key (see `DeviceKeyStore` +
   `apps/mobile/native/keychain-keystore/README.md`) lets the extension
   decrypt one row after a biometric prompt.
   Until one of these exists, `credential(for:)` stays a `fatalError`.
   Never "fix" it by storing passwords in the Keychain.
5. **Associated Domains.** Replace the placeholder with real
   `webcredentials:` entries, serve `apple-app-site-association` from
   each domain, and test matching in Safari.
6. **Passkeys.** `ASAuthorizationController` +
   `ASPasskeyCredentialRequest` for sign-in with a stored passkey;
   creation via `ASAuthorizationPlatformPublicKeyCredentialProvider`.
   Not started; the current skeleton is passwords only.
7. **Test on a real device.** Enable the provider in
   Settings → Passwords → AutoFill Passwords, then fill in Safari.
   Simulator testing is limited for credential providers.

## Build / test (Terminal on the Mac, after step 1)

```sh
cd apps/mobile
npx expo prebuild        # generates ios/ (only when the Xcode project is wanted)
open ios/*.xcworkspace   # add the Credential Provider target in Xcode, then Product → Run
```

No build has run. `swiftc` alone cannot validate this target — it needs
the Xcode project, the AuthenticationServices SDK, and the entitlements.

## Security rules (do not weaken)

- Fill only on a domain-matched origin (`DomainMatching.swift`).
- Only ONE credential per user pick; never the whole vault, never a key.
- No plaintext credentials at rest: not in the App Group, not in the
  Keychain, not in logs. The metadata index is titles/usernames/hosts only.
- Biometric enrolment change invalidates the device wrapping key
  (`biometryCurrentSet`); re-enrolment requires the passphrase.
- The React Native UI (`apps/mobile/src/`) does not fake AutoFill — there
  is no AutoFill button or flow in the app.

## Decisions taken in Phase F

- App Group `group.com.loygenics.my-secrect` — matches the existing
  spec in `apps/mobile/native/ios-credential-provider/README.md`.
- Extension bundle id `com.loygenics.my-secrect.CredentialProvider` —
  derived from the Tauri identifier `com.loygenics.my-secrect`.
- `fatalError` (not a silent empty result) for the missing decryption —
  a crash log names the gap; a silent failure would look like a wrong
  passphrase.
- Passkeys deferred: the skeleton is passwords only, rather than fake
  passkey methods with invented APIs.
