# Status ledger — checkpoint 2026-11-18 05:00 (local main, not pushed)

Authoritative over README / implementation-status / release-readiness, which are stale.

## Merged into local main and verified on main
| Area | Branch | Evidence (run on main) |
|---|---|---|
| CI fixes, Rust KDF scrypt→Argon2id, e2e CI jobs | main commits 4adb39d, 7c86104 | cargo 5+9+6, CI not run (not pushed) |
| Sync wiring, media wiring, restore UI | integrate/wave0 | sync e2e 15/15, media e2e 9/9, restore 10/10 |
| Crypto compat + v2 primitives (v1 still default) | fix/crypto-compat | npm test 31 + 125, cargo all pass |
| libsodium fail-closed self-test | main 84e71c2 | self-test 3/3 |
| Secure sharing (X25519, pinned fingerprints) | feat/sharing-e2ee | sharing e2e 10/10 + UI 1/1 |
| Deploy hardening, scenario L, CSP | feat/deploy-hardening | agent run: verify-restore PASS, CSP 0 violations |
| Desktop SQLCipher + Keychain (Tauri, macOS) | feat/desktop-secure-storage | storage tests 16/16; agent Tauri e2e PASS |
| Sync integrity (locks, replay, rollback, device auth) | fix/sync-integrity | merged; rspec + sync e2e not yet re-run after this merge |

Last full run on main before the last two merges: rspec 131/0, web e2e 13/13, extension e2e 18/18, typecheck all apps, builds desktop/web/extension.
Re-run 2026-11-18 04:05 on main a7a777c (after desktop storage + sync integrity): npm test 31/0 + 125/0, rspec 170/0, sync e2e 21/0.

## Generated imagery (2026-11-18, Colab A100, runtime deleted after download)
- Kept: 20 logo/icon concepts × 2 (user to choose), 49 cute soft-3D illustrations × 2, 8 animated loops (opaque + transparent WebP). Unpacked outside the repo at ../my-secrect-assets-inbox; models Qwen-Image + Wan 2.2 TI2V-5B (Apache-2.0), Real-ESRGAN x4plus (BSD-3), BiRefNet (MIT).
- Discarded: the first grey "product shot" set (dull, and a "Braun" style cue printed that trademark on some renders).


## Merged 2026-11-18 04:05–04:30 and verified on main 176779b
- feat/extension-hardening (sender validation, storage access level, visible-field fill, save/update, SW lifecycle): extension e2e 42/42.
- feat/auth-email-device-binding (email-verified sign-up, Ed25519 device proof, rate limits, audit, HKDF recovery verifier, deletion tombstones).
- feat/media-complete (bounded uploads, quota, resume, encrypted thumbnails, orphan sweep).
- Full run on main: npm test 31/0 + 135/0, security mirrors 61/0, RSpec 270/0 (3 MinIO-only pending), sync e2e 21/0 (harness now does email code + device proof), web e2e 19/0, restore e2e 10/0, extension e2e 42/0, cargo 20/0, typecheck desktop/web/extension/mobile, web + extension builds.
- Not re-run on main yet: sharing e2e and media e2e (their registration helpers predate the email step; owners are adapting them), deploy scripts (infra follow-up in progress).

## Merged 06:45: feat/android-credential-provider-v2
Credential Manager password provider (API 34+): lists matching autofill_index logins, BiometricPrompt CryptoObject unwrap, decrypts only the chosen row, Chrome allowlist + two-way Digital Asset Links for apps, uses the app's libsodium.so. Emulator run (API 37, agent): third-party getCredential received the chosen PasswordCredential after fingerprint; cancel and no-DAL negatives correct; JVM 21/21, instrumented 20/21 (+1 opt-in skip). On main: both provider plugins prebuild together (expo prebuild --platform all), npm test 31/0 + 187/0, mobile typecheck clean. Not done: physical device, Android 14–16 images, passkeys, save/create, < API 34 fallback, allowBackup exclusion of filesDir/my-secrect.

## Merged 06:30: feat/ios-credential-provider-v2
AutoFill Credential Provider extension (Expo plugin adds target + entitlements; swift-sodium + SQLCipher.swift). Reads the app's vault.db + keychain items, biometric unlock per scheme, decrypts only the chosen row, checks the item URL against the page. Simulator run (iOS 26.5, agent): Safari QuickType fill and key-icon list fill both worked after Face ID; swift test 40/40 (re-run on main: 40/40). Not done: physical device / signing (needs paid Apple team for App Group + keychain group), Secure Enclave scheme end to end, passkeys, app-side refresh of QuickType identities.

## Merged 06:15: fix/mobile-post-merge
Mobile K2 item-index check on the SQLCipher vault; cross-impl and acceptance harnesses run the real mobile vault on sql.js. On main: npm test 31/0 + 187/0, acceptance 48/48 (0 todo, no failing subtests), mobile typecheck clean. QA K2 closed on desktop/web, extension and mobile.

## Merged 06:00: feat/mobile-secure-storage
SQLCipher vault.db, AsyncStorage migration, DeviceKey (iOS keychain/SE, Android Keystore + BiometricPrompt), biometric unlock and invalidation, native libsodium on iOS/Android via react-native-libsodium (Hermes has no WebAssembly). Agent runs on iOS simulator + Android emulator: 14/14 crypto vectors, create → biometric → cold-start unlock, desktop backup restored on the phone. Decisions to note: SHA-256 on mobile comes from @noble/hashes (audited; the native binding lacks it); v2 item AD with bytes ≥0x80 is refused by the native binding until a binary-capable binding exists. On main a1e0112: npm test 31/0 + 185/2 (the 2 = cross-impl harness, being fixed), acceptance 24/0 (+1 todo), mobile typecheck clean.

## Merged 05:30: fix/backup-integrity-v2 (QA K2)
Backup format_version 3 with an HKDF-keyed authenticated item index; desktop/web and extension refuse a backup with items removed, added or re-versioned; v2 backups restore with an "item list not verifiable" warning. Mobile part (e2c1567) held until the mobile storage merge. On main 54dcc29: npm test 31/0 + 160/0, acceptance 47/0 (+1 todo: mobile K2), restore e2e 12/0, acceptance e2e 30/0 (+1 todo: K3).

## Merged 04:45–05:00 and verified on main
- feat/design-system-adoption: Precision Instrument redesign (tokens, Lucide, clay item-type colours, 29 illustrations + 4 motion clips, responsive rail/drawer/tab bar/thumb rail, key-turn unlock, en/vi + appearance settings), 9 walkthrough bugs, QA E1 + H4. axe: 0 violations (44 scans).
- fix/sync-qa: C1 vault key check (`vault_mismatch`, nothing pushed), H3 sign-out on pull 401/403, tombstones for deletes/purges made while sync is off, K3 closure plan in specs/sync-protocol.md.
- fix/infra-auth-media: SMTP required, test-only Mailpit with STARTTLS, email step + device proof in smoke/verify-restore/media e2e, tombstone export/import/reapply in the restore runbook. Agent runs: scenario L PASS, smoke PASS, CSP PASS, media e2e 17/17 + Chromium PASS.
- fix/auth-revocation: H2 durable revocation (passkey re-approval, revoke_passkey, revoked keys never re-enrol) + L5 self-test callers.
- Main run after these merges: npm test 31/0 + 155/0, RSpec 286/0 (3 MinIO-only pending), sync e2e 28/0, web e2e 19/0, acceptance 45/0 (+3 todo) and acceptance e2e 30/0 (+1 todo: K3), typecheck all four apps.

## Merged 04:45: fix/sharing-review
All six review findings fixed (pinned email shown, reviewed revision saved, identity reset with step-up, recipient content validated, wrapped key bound to its share = record v2, spec aligned). On main 423170e: npm test 31/0 + 138/0, RSpec 273/0, sharing e2e 14/0 + UI 1/0, typecheck all apps.

## Independent security review (crypto + sharing): no critical/high
Medium: sharing UI shows server-supplied email instead of the pinned one (M1); "Save to my vault" saves the latest revision instead of the reviewed one (M2). Low: L1–L6 (vault string cipher has no per-purpose AD; identity registration without step-up/reset; recipient fields not validated; key-exchange check not share-bound; self-test bypassed by 4 raw sodium.ready callers; spec drift). Sharing findings fixed and merged (L1 vault string cipher AD and L5 self-test callers still open).

## QA acceptance (tests/acceptance, merged into main cb1bca6)
On main cb1bca6: npm run test:acceptance 45 pass / 3 todo; npm run test:acceptance:e2e 25 pass / 0 fail / 6 todo (todos = known defects, asserted as the correct behaviour). DEFECT-H1 fixed by the auth merge. New deploy blocker L1: compose lacks SMTP_* / MAIL_FROM (infra branch fixing).
Covered: A, B, D, E, I, K, M. Partial: C, F, H. Pending: G, J, L. Open defects: H1/H2 device revocation (re-check on main), H3 pull 401 not handled, H4 local-only choice not sticky, C1 different vault key pushes unreadable items (high), K3 rollback (high, needs v2 AD + signed events), K2 backup item omission undetected, E1 relations rewritten on save.

## In progress
- Logo chosen by the user: 07_ghost_key (seed 8209); wired on feat/ui-soften (brand mark, favicons, Tauri and mobile icons).

## Open (not assigned yet)
- Mobile UI: "+ New" and detail "Back" sit under the status bar on iOS and Android (reported by three agents).
- Mobile: app should refresh iOS QuickType identities after each autofill_index rewrite; Android allowBackup should exclude the device-only vault.
- GitHub CI has never run on the current main: local main is ahead of origin and only the user pushes.
- K3 rollback (high): v2 AD with revision + device-signed sync events (plan in specs/sync-protocol.md).
- Review L1: Vault-Key string cipher has no per-purpose AD.
- RetentionJob and expiry of tombstones / sessions / unfinished email verifications not scheduled.
- Mobile: no device binding or sync yet; several screens still English; light/dark off until all screens use the mobile theme.
- Screens owned elsewhere (Security Center, sign-in, media, shares, sync bar) still use legacy classes and English strings.
- Extension: Firefox unsupported; strings not in i18n.

## Open defects / decisions
- Passphrase Unicode normalisation (NFC) needs a KDF version bump.
- Sync event signatures not implemented (spec: specs/device-identity.md, purpose `sync-event` reserved).
- Deletes made while sync is off never reach the server (needs vault.ts tombstone queue).
- Retention/orphan jobs not scheduled; account deletion leaves no tombstone for backup re-apply.
- UI: 9 walkthrough bugs incl. no mobile layout (assigned to the design work).

## External, human-controlled (all PENDING)
Push + GitHub CI, production hosting/domain/TLS/SMTP, Apple/Google accounts and signing, store review, legal privacy review, external security audit.
