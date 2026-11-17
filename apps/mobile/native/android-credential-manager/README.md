# Android Credential Manager — PLANNED, not implemented

## Goal
Android 14+ Credential Manager provider: the vault offers passkeys
and passwords in the system credential picker, and fills only the
credential the user picks, after vault unlock. Older Android needs
the separate Autofill Framework integration.

## What is needed (native work, Android Studio)
- `androidx.credentials` Credential Manager provider service
  (`CredentialProviderService`), Digital Asset Links association
  (`assetlinks.json` on each relying-party domain) for passkey /
  password matching — never fill on a mismatched origin.
- `CreateCredentialRequest` (passkey creation) and
  `GetCredentialRequest` (passkey + password retrieval) handling;
  passkey crypto (ES256/EdDSA signing) must happen with the vault
  key for that item only, never with the whole vault unlocked into
  the provider process.
- Autofill Framework (`AutofillService`) for Android < 14, with the
  same origin check and user-confirmed fill.
- Bank accounts: require explicit user confirmation before filling
  (per the architecture spec).

## Status
No Kotlin/Java provider code, no manifest service entries and no
Digital Asset Links file exist yet in this repo. The React Native UI
in `src/` does not fake Credential Manager / Autofill — there is no
such button or flow in the app. This folder is the spec + checklist
for the native step.

## Phase F update (17 Nov 2026) — skeleton now exists, still NOT working
The Kotlin skeleton landed in `native/android-credential-provider/`:
`MySecrectCredentialProviderService.kt` (real service shape + dispatch;
both entry points fail closed with protocol-correct "no credential"
errors), `VaultKeystore.kt` (real AndroidKeyStore device-key code +
row parsing; wraps nothing yet), `DomainMatching.kt` (real, complete
origin gate), plus a manifest snippet, an `assetlinks.json` template
(SHA-256 fingerprint is a placeholder), and a Gradle fragment.
Nothing has run in Android Studio. The remaining steps are in that
folder's README.md — Android project, vault handoff, selection UI,
passkey signing, Digital Asset Links, AutofillService for Android < 14,
device testing.
