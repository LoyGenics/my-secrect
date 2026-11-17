# Mobile local store and device unlock — contract v1

Status: FROZEN 2026-11-17 by the orchestrator. Three workstreams build
against this file at the same time: the mobile app storage + biometric
unlock, the iOS Credential Provider, and the Android Credential
Provider. Do not change a name, path, column or blob layout here without
the orchestrator's approval; propose changes in your report instead.

Vault crypto is unchanged: `specs/encryption-format.md` v1 (Argon2id
INTERACTIVE KEK, XChaCha20-Poly1305 IETF, stored as base64
`nonce(24) || ciphertext+tag`). This contract only covers where the
existing encrypted rows and wrapped keys live on a phone, and how a
device-protected key unlocks them.

## 1. Location

| Platform | Directory |
|---|---|
| iOS | App Group `group.com.loygenics.my-secrect` container, `Library/Application Support/my-secrect/` |
| Android | app-private `Context.getFilesDir()/my-secrect/` (the provider service runs inside the app process) |

The iOS app and the Credential Provider extension both read this
directory. Nothing in it is plaintext vault content.

## 2. Database `vault.db`

SQLite encrypted with SQLCipher 4 default settings. The database key is
the **Local Storage Key (LSK)**: 32 random bytes, applied as a raw key
(`PRAGMA key = "x'<64 hex>'"`).

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,          -- 'schema_version' = '1'
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_keys (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL               -- StoredKeys JSON, unchanged from apps/mobile/src/vault.ts
);
CREATE TABLE IF NOT EXISTS rows (
  id               TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL,
  nonce            TEXT NOT NULL,
  ciphertext       TEXT NOT NULL,
  wrapped_item_key TEXT NOT NULL,
  wrapped_nonce    TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE TABLE IF NOT EXISTS device_unlock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  scheme       TEXT NOT NULL,      -- see section 4
  wrapped_amk  TEXT NOT NULL,      -- base64, opaque per scheme
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS autofill_index (
  id       TEXT PRIMARY KEY,       -- vault item id
  title    TEXT NOT NULL,
  username TEXT NOT NULL,
  host     TEXT NOT NULL,          -- registrable host, lower-case, no scheme
  type     TEXT NOT NULL           -- 'login' | 'passkey'
);
```

Rules:

- `rows` holds exactly the encrypted row shape the app already uses. A
  provider decrypts one row by id; it never writes to `rows` or
  `vault_keys`.
- `autofill_index` holds titles, usernames and hosts for login and
  passkey items only. Never passwords, TOTP secrets, notes or keys. The
  app rewrites it after each unlock and after each item write, and
  clears it on lock-out settings change or wipe.
- Migration from AsyncStorage: on first launch of the new build, if the
  AsyncStorage keys `my-secrect.local-vault.v1` /
  `my-secrect.local-vault.v1.keys` exist, copy them into `vault.db` in
  one transaction, verify the row count, then delete the AsyncStorage
  keys. A failed copy leaves AsyncStorage untouched and surfaces an
  error; it never drops rows.

## 3. Local Storage Key

| Platform | Storage |
|---|---|
| iOS | Keychain generic password, service `com.loygenics.my-secrect.lsk`, account `v1`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, keychain access group `$(AppIdentifierPrefix)com.loygenics.my-secrect.shared` (shared with the extension). No biometric gate: the LSK only protects at-rest metadata; vault content needs the Vault Key. |
| Android | 32 random bytes, encrypted with AndroidKeyStore AES-256-GCM key alias `my-secrect.lsk.v1` (no user-auth requirement), stored as `iv(12) || ct+tag` in `filesDir/my-secrect/lsk.bin`. |

## 4. Device unlock (biometric quick unlock)

A device-protected key wraps a copy of the **Account Master Key (AMK)**.
Biometric success releases the AMK; the Vault Key and item keys are
then unwrapped exactly as after a passphrase unlock. The plaintext AMK
is never written to disk.

`device_unlock.scheme` values and blob layouts:

| scheme | Platform | Key | `wrapped_amk` |
|---|---|---|---|
| `ios-se-p256-ecies-v1` | iOS with Secure Enclave | SE P-256 private key, tag `com.loygenics.my-secrect.device-unlock.v1`, access control `.privateKeyUsage` + `.biometryCurrentSet`, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, shared access group | `SecKeyCreateEncryptedData(pub, .eciesEncryptionCofactorVariableIVX963SHA256AESGCM, amk)` |
| `ios-kc-aesgcm-v1` | iOS without SE (simulator) | 32-byte random key in Keychain, service `com.loygenics.my-secrect.device-unlock`, account `v1`, `.biometryCurrentSet`, same accessibility and access group | CryptoKit `AES.GCM.seal(amk).combined` (nonce 12 ‖ ct ‖ tag 16) |
| `android-ks-aesgcm-v1` | Android | AndroidKeyStore AES-256-GCM alias `my-secrect.device-unlock.v1`, `setUserAuthenticationRequired(true)`, `setInvalidatedByBiometricEnrollment(true)`, StrongBox when available; used through `BiometricPrompt.CryptoObject` | `iv(12) ‖ ct ‖ tag(16)` |

Rules:

- Enrolment happens only right after a successful passphrase or
  recovery-key unlock, when the AMK is in memory.
- Biometric enrolment change invalidates the key. The app must then
  delete the `device_unlock` row, tell the user, and require the
  passphrase. It never falls back silently.
- "Disable biometric unlock", wipe, and passphrase change delete the
  key and the row (passphrase change re-enrols only if the user asks).
- Errors cross the native boundary as these codes: `NOT_AVAILABLE`,
  `NOT_ENROLLED`, `KEY_INVALIDATED`, `USER_CANCEL`, `LOCKOUT`,
  `AUTH_FAILED`, `CORRUPT`. No other outcome may unlock the vault.

## 5. Native module `DeviceKey` (Expo local module `apps/mobile/modules/device-key`)

Owned by the mobile storage workstream. The providers reuse the same
keychain tags / keystore aliases from native code; they do not call
this JS API.

```ts
isAvailable(): Promise<{ available: boolean; biometry: 'faceId' | 'touchId' | 'fingerprint' | 'none'; scheme: string | null }>
getOrCreateStorageKey(): Promise<string>                    // LSK as 64 hex chars
enroll(amkB64: string, prompt: string): Promise<{ scheme: string; wrappedAmkB64: string }>
unwrap(scheme: string, wrappedAmkB64: string, prompt: string): Promise<string>  // AMK base64
remove(): Promise<void>
```

## 6. Credential providers

Both providers follow the same path for one fill request:

1. Read candidate items from `autofill_index` (open `vault.db` with the
   LSK) and match the requesting domain with the existing
   `DomainMatching` code. The user picks one item.
2. Read `device_unlock`; if missing, fail closed with "Open my-secrect
   and enable biometric unlock".
3. Biometric prompt → unwrap AMK → unwrap Vault Key from
   `vault_keys.json` (`wrapped_vault`) → unwrap the item key → decrypt
   that single row → return only that item's username and password.
4. Zero every key buffer before returning. Never cache plaintext.

Any decryption, parse or auth failure cancels the request with the
platform's "credential not found / failed" result. Never return an
empty or fabricated credential.

## 7. Generated native projects

`apps/mobile/ios` and `apps/mobile/android` are generated by
`npx expo prebuild` and are not committed. Every native change
(extension target, provider service, entitlements, Gradle deps,
SQLCipher) goes through Expo config plugins under `apps/mobile/plugins/`
or the local module under `apps/mobile/modules/`.
