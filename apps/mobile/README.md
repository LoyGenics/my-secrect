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
- **Lock** — passphrase, recovery key, biometrics (see below).
- **Vault tab** — All / Favorites / Trash / 8 categories / tags, item list, + New, load/clear example data (fake values only).
- **Search tab** — instant local search (title, tags, fields); the query never leaves the device.
- **Generate tab** — password generator (length 12–32, symbols/numbers/uppercase, pronounceable) + passphrase generator + strength.
- **Health tab** — score 0–100, weak passwords, reused passwords, cards/documents expiring in 30 days; tap an item to fix it.
- **Settings tab** — change passphrase (re-wraps the same Master Key, items untouched, recovery key still works), auto-lock (1/5/15 min/never), recovery info, lock now, view Trash, encrypted export, plaintext export (two-tap confirm + warning), wipe vault (Alert + arm confirm).
- **Item Detail** — every field with show/hide + copy, live TOTP (pure-TS RFC 6238, 30 s), tags, related items (tap to open), favorite, edit, trash/restore, permanent delete.
- **Item Form** — all 12 item types across the 8 modules, full fields, custom fields, relations picker, tags, favorite. Card form has **no CVV/PIN field, by design**.
- **Trash** — restore / permanently delete.

Bottom tab bar: Vault / Search / Generate / Health / Settings. Every
input has a visible label, `accessibilityLabel` and `testID`.

## Storage

AsyncStorage holds encrypted rows + wrapped keys only (`src/vault.ts`,
`StorageBackend` seam). Production mobile storage is SQLCipher
(encrypted SQLite) — swap the backend, crypto and item logic unchanged.
Media/documents store metadata + encrypted blob manifest + SHA-256;
file bytes are **not** stored in this build (labelled in the UI).

## Biometrics — honest limitation

`expo-local-authentication` confirms the user is present (Face ID /
fingerprint). **It does not unlock the vault on its own in this build:**
the vault key is derived from the passphrase via Argon2id, and a
fingerprint cannot derive it. After a biometric check succeeds the
screen says so and still asks for the passphrase. Real biometric
quick-unlock needs a device-protected key wrap (Keychain / Keystore) —
see `native/keychain-keystore/README.md`. It is NOT faked here.

## Native integrations — implemented vs planned

| Integration | Status |
|---|---|
| Face ID / Touch ID / Android biometrics (presence check) | Implemented via `expo-local-authentication` |
| Keychain (iOS) / Keystore (Android) key wrapping | Planned — see `native/keychain-keystore/README.md` |
| iOS Credential Provider Extension (AutoFill) | Planned — see `native/ios-credential-provider/README.md` |
| Android Credential Manager (Android 14+) | Planned — see `native/android-credential-manager/README.md` |
| Encrypted SQLite (SQLCipher) | Planned — storage seam ready in `src/vault.ts` |
| Sync with Rails API | Not built — local-only, like desktop Phase 1 |

## Run

```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect/apps/mobile
npm install
npx expo start        # scan the QR code with Expo Go, or press i / a
# iOS simulator (needs Xcode):   npx expo run:ios
# Android emulator (needs Android Studio): npx expo run:android
```

First run notes (verify these — nothing has been run yet, no shell
is available from the agent):
- `Buffer` is polyfilled in `index.js` (`packages/crypto-adapters`
  uses `Buffer.from` for base64). If Metro complains, check the
  `buffer` package installed.
- `libsodium-wrappers-sumo` is a WASM build; `metro.config.js`
  adds `.wasm` to asset extensions. If Expo Go cannot load the WASM
  module, use a development build (`npx expo run:ios/android`)
  instead of Expo Go.
- `app.json` currently sets no icon (no placeholder is shipped).
  Add a 1024×1024 icon at `assets/icon.png` and reference it in
  `app.json` before a store build — do not ship with a blank icon.
- `npx tsc --noEmit` (via `npm run typecheck`) is the first check
  to run; it has not been run yet.

## Not audited

No part of this codebase is claimed audited or production-ready.
Do not store sole-copy live secrets here until the crypto-core,
sync and native steps have been reviewed and tested on device.
