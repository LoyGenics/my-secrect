# Status ledger — checkpoint 2026-11-18 04:30 (local main 176779b, not pushed)

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

## Merged 04:45: fix/sharing-review
All six review findings fixed (pinned email shown, reviewed revision saved, identity reset with step-up, recipient content validated, wrapped key bound to its share = record v2, spec aligned). On main 423170e: npm test 31/0 + 138/0, RSpec 273/0, sharing e2e 14/0 + UI 1/0, typecheck all apps.

## Independent security review (crypto + sharing): no critical/high
Medium: sharing UI shows server-supplied email instead of the pinned one (M1); "Save to my vault" saves the latest revision instead of the reviewed one (M2). Low: L1–L6 (vault string cipher has no per-purpose AD; identity registration without step-up/reset; recipient fields not validated; key-exchange check not share-bound; self-test bypassed by 4 raw sodium.ready callers; spec drift). Sharing findings fixed and merged (L1 vault string cipher AD and L5 self-test callers still open).

## QA acceptance (tests/acceptance on test/acceptance, being ported to main)
Covered: A, B, D, E, I, K, M. Partial: C, F, H. Pending: G, J, L. Open defects: H1/H2 device revocation (re-check on main), H3 pull 401 not handled, H4 local-only choice not sticky, C1 different vault key pushes unreadable items (high), K3 rollback (high, needs v2 AD + signed events), K2 backup item omission undetected, E1 relations rewritten on save.

## In progress (agents, each on its own branch)
- fix/sync-qa: QA C1, H3, offline tombstones; K3 closure plan.
- fix/infra-auth-media: SMTP + mail catcher for test stacks, email step + device proof in smoke/verify-restore/media e2e, tombstone runbook.
- feat/design-system-adoption: Precision Instrument redesign, responsive, 9 walkthrough bugs, illustrations + motion, QA E1/H4.
- feat/mobile-secure-storage: SQLCipher store, biometric unlock.
- test/acceptance-main: QA suites ported to main.
- Paused: feat/ios-credential-provider, feat/android-credential-provider (resume after mobile storage lands).
- Waiting on the user: logo choice.

## Open defects / decisions
- Passphrase Unicode normalisation (NFC) needs a KDF version bump.
- Sync event signatures not implemented (spec: specs/device-identity.md, purpose `sync-event` reserved).
- Deletes made while sync is off never reach the server (needs vault.ts tombstone queue).
- Retention/orphan jobs not scheduled; account deletion leaves no tombstone for backup re-apply.
- UI: 9 walkthrough bugs incl. no mobile layout (assigned to the design work).

## External, human-controlled (all PENDING)
Push + GitHub CI, production hosting/domain/TLS/SMTP, Apple/Google accounts and signing, store review, legal privacy review, external security audit.
