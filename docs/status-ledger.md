# Status ledger — checkpoint 2026-11-18 (local main, not pushed)

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

## Done on branches, not merged yet
- feat/auth-email-device-binding (email ownership, device proof, rate limits, audit): agent reports rspec 149/0, web e2e 19/19. Merge needs: sync e2e harness must bind a device (sync now requires an active device), infra smoke `register` needs the email step, SMTP env in compose.

## In progress (agents running)
Mobile SQLCipher + biometric unlock; iOS and Android credential providers; extension hardening; media completion; QA acceptance matrix; UI redesign "Precision Instrument" (PRODUCT.md + apps/desktop/.impeccable/surfaces/apps-desktop-src-app-tsx.md); independent review of crypto + sharing; AI renders on Colab (Qwen-Image, Apache-2.0).

## Open defects / decisions
- Passphrase Unicode normalisation (NFC) needs a KDF version bump.
- Sync event signatures not implemented (spec: specs/device-identity.md, purpose `sync-event` reserved).
- Deletes made while sync is off never reach the server (needs vault.ts tombstone queue).
- Retention/orphan jobs not scheduled; account deletion leaves no tombstone for backup re-apply.
- UI: 9 walkthrough bugs incl. no mobile layout (assigned to the design work).

## External, human-controlled (all PENDING)
Push + GitHub CI, production hosting/domain/TLS/SMTP, Apple/Google accounts and signing, store review, legal privacy review, external security audit.
