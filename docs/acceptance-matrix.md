# Release acceptance matrix

Independent verification by QA (Agent 15), branch `test/acceptance` off
`integrate/wave0`, 2026-11-18. Every status below comes from a suite that
was **run**, not from a status doc or commit message. "Real" means the test
imports or drives production code (packages/*, apps/*, the Rails API,
Chromium); "mirror" means the rule is re-implemented inside the test file.

Known defects are encoded in `tests/acceptance/` as the CORRECT expectation
with `todo: 'DEFECT-…'`: they run on every invocation and print the failure,
but do not fail the run. `ACCEPTANCE_STRICT=1` turns them into failures.

## 1. Summary

| | Scenario | Status | Blocking defects |
|---|---|---|---|
| A | Onboarding (account → identity → passkey → vault → recovery material → encrypted item) | **covered** | — |
| B | Passkey login, then independent vault unlock | **covered** | — |
| C | Cross-device sync, create/edit both ways | **partial** | DEFECT-C1 (wrong-key device poisons the shared vault) |
| D | Offline conflict, no data loss | **covered** (Keep both only) | — |
| E | Portable backup → fresh device, every item + relation | **covered** with known defects | DEFECT-K2-omission, DEFECT-E1; trash and media bytes are not in a backup (by design) |
| F | Media round trip on another device | **covered** (web ↔ web) | gap: mobile / extension media not tested |
| G | Secure sharing | **pending** (another agent) | — |
| H | Device revocation | **partial** — sessions die, offline copy honest; revocation not durable | DEFECT-H1, H2, H3, H4 |
| I | Browser autofill with origin checks | **covered** | — |
| J | Native credential providers | **pending** (another agent) | — |
| K | Recovery failure (wrong credentials, corrupted backup, tampered ciphertext) | **covered** with known defects | DEFECT-K2-omission, DEFECT-K3-rollback |
| L | Deploy / restore | **pending** (another agent) | — |
| M | Account deletion through the product | **covered** (web) | gap: mobile/extension deletion UI not tested |

## 2. Per scenario

### A — Onboarding
| Test | What it really proves | Real? |
|---|---|---|
| `tests/e2e-web/onboarding.spec.ts` › onboarding: register with passkey, create vault, recovery key shown once | Chromium + Rails: account created with a real WebAuthn attestation, session token issued, vault onboarding shows a 43-char recovery key once | real |
| `tests/acceptance/account-deletion.e2e.test.ts` › A registers, creates a vault, syncs items and uploads encrypted media through the UI | same UI chain continued to items created in the item form and pushed (rows in `items`), media ciphertext in MinIO | real |
| `tests/sync-e2e/two-clients.test.ts` › convergence + server stores ciphertext only | full `pg_dump` + API log contain no plaintext marker | real (Node clients) |
| `tests/sync-e2e/conflict-ui.test.ts` › Keep both in the UI … ciphertext only | browser-originated writes reach Postgres as ciphertext only | real |
| `tests/acceptance/mirror-replacements.test.ts` › createVault issues a 32-byte base64url key … | the recovery key the real vault issues is 256-bit, unique, opens the vault, never stored | real module |

Gap: "identity" is read as the account identity (email + user row); no identity *item* is part of onboarding.

### B — Passkey login, independent unlock
| Test | Proves | Real? |
|---|---|---|
| `tests/e2e-web/auth.spec.ts` › sign out revokes the server session; passkey sign-in works; sign-in does not unlock the vault | real assertion verified by Rails (signCount advances); after sign-in the vault is still locked; wrong passphrase fails without touching the session | real |
| `tests/e2e-web/auth.spec.ts` › vault lock does not sign out … | lock/reload keep the account session, never the unlocked vault | real |
| `tests/e2e-web/mfa.spec.ts` (3 tests) | TOTP second factor at sign-in, recovery codes single-use | real |
| `apps/api/spec/requests/api/v1/passkeys_spec.rb` (wrong origin / RP ID / replay / tampered signature / other account) | server-side WebAuthn verification | real (RSpec) |

### C — Cross-device sync
| Test | Proves | Real? |
|---|---|---|
| `tests/sync-e2e/two-clients.test.ts` › B joins…, edit on B reaches A, delete on A becomes a tombstone…, offline queue survives a reload… | two real clients (desktop vault + SyncEngine + SDK) through Rails: create/edit/delete both ways, queue persistence | real (Node hosts) |
| `tests/sync-e2e/conflict-ui.test.ts` › unlock in the real UI -> sync indicator goes idle and shows the pulled item | Chromium web app pulls a Node device's item | real |
| `tests/acceptance/device-revocation.e2e.test.ts` › device B (real Chromium) signs in with its own passkey, restores the backup, unlocks and pulls A's items | a fresh browser joins via backup restore + passkey and pulls | real |
| `tests/acceptance/sync-integrity.e2e.test.ts` › wrong vault key (C created its own vault instead of restoring)… | a device holding a different vault key applies nothing it cannot decrypt; A's data intact; the error is visible | real |
| same file › a device whose vault key cannot open the account vault refuses to push into it | **DEFECT-C1** (todo) | real |

Gap: no test drives two browsers both editing through the UI; the second device is a Node client in every sync test.

### D — Offline conflict, no data loss
| Test | Proves | Real? |
|---|---|---|
| `tests/sync-e2e/two-clients.test.ts` › CONFLICT: both edit offline -> stale 409 -> … Keep both loses nothing | server refuses LWW (409), both decrypted versions kept, stored encrypted, Keep both yields both items on both devices | real |
| same › DELETE vs UPDATE / UPDATE vs local DELETE | delete/edit races keep the edited version alive | real |
| `tests/sync-e2e/conflict-ui.test.ts` › … conflict list shows BOTH decrypted versions / Keep both in the UI | the UI path for the same | real |
| `packages/sync/tests/real-sync-client-import.test.ts` (18 tests) | `applyRemoteEvents` edge cases | real module |

Gap: only "Keep both" exists; `SyncConflict.resolution` also declares `kept_local` / `kept_remote`, which no UI offers.

### E — Portable backup on a fresh device
| Test | Proves | Real? |
|---|---|---|
| `tests/acceptance/portable-backup.e2e.test.ts` › profile A … encrypted export via the UI | relation-rich vault (typed relations, tags, favorites, attachments, nested collections, one item made in the item form, one trashed in the UI) exported through the UI (step-up + download); no plaintext in the file | real (Chromium) |
| same › fresh profile B: restore with the passphrase … every relation resolves in the UI | brand-new profile restores through the UI; every live item is field-identical; every relation renders its target (no "(not found)") | real |
| same › fresh profile C: restore with the recovery key … | same with the recovery key | real |
| same › the same web backup restores in the real MV3 extension | the web file restores in the built extension's options UI, every item identical | real |
| same › editing a restored item … keeps its typed relations | **DEFECT-E1** (todo) | real |
| `tests/acceptance/recovery-failures.test.ts` › E: a backup from any app restores on a fresh device of any app (9 tests) | desktop ↔ extension ↔ mobile restore code (three separate copies) all accept each other's backups; items, relations, recovery key and passphrase survive | real modules |
| `tests/e2e-web-restore/restore.e2e.test.ts`, `extension-restore.e2e.test.ts` | UI restore happy paths + existing vault never overwritten | real |

By design (documented in `apps/desktop/src/vault.ts` `exportEncrypted`): trash is not exported; media bytes stay in object storage (the backup carries only the item that references the blob).

### F — Media round trip on another device
| Test | Proves | Real? |
|---|---|---|
| `tests/acceptance/media-cross-device.e2e.test.ts` › device A: … upload an encrypted file / device B (another browser profile): … download + decrypt the same bytes | A uploads 3 chunks through the Media gallery to MinIO; a second Chromium profile signs in with the synced passkey, restores A's backup, gets the media item by sync, sees "Manifest: verified" and downloads byte-identical plaintext | real (Chromium + Rails + MinIO) |
| `tests/media-e2e/media.e2e.test.mts` (9 tests) | 10 MiB file through real API + MinIO via Caddy; stored bytes are ciphertext; wrong key, flipped / swapped / duplicated / truncated / foreign chunks rejected | real (one token, one vault key) |
| `tests/media-e2e/browser.e2e.mjs` | MediaView upload + download in Chromium, no plaintext on the wire, wire tamper rejected | real (same browser) |
| `packages/storage/tests/upload.real.test.mts` (22 tests) | chunk/manifest/tamper/resume rules | real module, in-memory store |

Gap: the second device is always the web app; mobile has no media round-trip test.

### G — Secure sharing: pending
Existing only: `packages/core/tests/sharing-proposal.test.mjs` (real module), `apps/api/spec/requests/api/v1/shares_spec.rb`. No end-to-end share.

### H — Device revocation
| Test | Proves | Real? |
|---|---|---|
| `tests/acceptance/device-revocation.e2e.test.ts` › revoking B's device: B's token is refused on every route | vaults, sync pull/push, key envelopes, devices, sessions, blobs all 401 | real |
| same › B's browser returns to sign-in on its next account call ("session expired"); the encrypted vault stays on the device | honest limit: revocation is not a remote wipe | real (Chromium) |
| same › honest offline limit: after a reload the revoked browser still opens and reads its local vault with no session | | real |
| same › B's session is bound to a device record of its own / only B is cut off | **DEFECT-H1** (todo ×2) | real |
| same › the revoked device cannot sign in again … | **DEFECT-H2** (todo) | real |
| same › B's next SYNC call after the revocation sends it back to sign-in | **DEFECT-H3** (todo) | real |
| same › "Continue without signing in" right after the session-expired bounce opens the local vault | **DEFECT-H4** (todo) | real |
| `tests/e2e-web/security-center.spec.ts` › sessions / trusted devices (3 tests) | revoke one session / all others (step-up), revoke device UI, honest copy | real |

### I — Browser autofill with origin checks
| Test | Proves | Real? |
|---|---|---|
| `apps/extension/e2e/extension.spec.ts` (18 tests) | built MV3 extension in Chromium: fills exact host and subdomain; refuses suffix tricks, hyphen lookalike, punycode homograph, unrelated host, http-vs-https, raw IP; punycode/bank items need confirmation; blocked origin wins | real |
| `apps/extension/tests/domain.test.ts` | the fill gate module | real module |

Gap: forms inside cross-origin iframes are not exercised.

### J — Native credential providers: pending
`native/ios-credential-provider`, `native/android-credential-provider` have no automated tests.

### K — Recovery failure
| Test | Proves | Real? |
|---|---|---|
| `tests/acceptance/recovery-failures.test.ts` › K1 (×3 apps + post-restore unlock) | wrong passphrase, empty passphrase, another vault's (valid) recovery key, random 32-byte key, malformed/short keys, both secrets, right secret + wrong backup: rejected with the specific reason, storage byte-identical, vault locked, nothing visible — in desktop, extension and mobile restore code | real modules |
| same › K2 (×3 apps) | truncated/non-JSON, v1/v3, wrong `format`, missing envelope, non-array items, weakened KDF, duplicate ids, bad base64, too-short blob, flipped `wrapped_master` / `salt` / `wrapped_vault` / `wrapped_recovery`, short nonce | real modules |
| same › a backup with one item silently removed is detected (×3) | **DEFECT-K2-omission** (todo) | real modules |
| same › corrupted wrapped_recovery … recovery key then fails safely later | documented limit (cannot be checked without the recovery key) | real modules |
| same › K3 (×3 apps) + importEncrypted no partial merge | flipped payload/item-key bytes (first/middle/tag), swapped payloads, relabelled rows, a foreign vault's row spliced in | real modules |
| `tests/e2e-web-restore/restore.e2e.test.ts` › negative cases … ; `extension-restore.e2e.test.ts` › negative cases … | the same failures through the restore UIs, with user-facing messages | real (Chromium) |
| `tests/acceptance/sync-integrity.e2e.test.ts` › K3 tampered wrapped item key / K2 truncated / K3 swapped between two items | sync pull rejects, does not apply, reports every run, recovers when intact | real stack |
| same › K3 rollback | **DEFECT-K3-rollback** (todo) | real stack |
| `tests/sync-e2e/two-clients.test.ts` › a ciphertext that fails AEAD is reported … | flipped payload byte on pull | real |

Gap: the mobile restore UI (React Native) is not exercised; only its module.

### L — Deploy / restore: pending

### M — Account deletion
| Test | Proves | Real? |
|---|---|---|
| `tests/acceptance/account-deletion.e2e.test.ts` (6 tests) | UI deletion with passkey step-up; both browsers' sessions 401 on every route; zero rows of the account in 16 checks across all tables (audit events kept with `user_id` NULL, no email); MinIO bucket empty; old passkey refused; email re-registers as a new empty account; local vault kept, as the UI states | real (Chromium + Rails + MinIO) |
| `tests/e2e-web/security-center.spec.ts` › Security Center: account deletion | step-up required, cancel deletes nothing | real |
| `apps/api/spec/requests/api/v1/account_deletion_spec.rb`, `account_deletion_storage_spec.rb`, `spec/domains/accounts_delete_storage_spec.rb` | cascade, step-up, other-account safety, storage failure keeps the account | real (RSpec, in-memory storage adapter) |

## 3. Mirror tests (rule-only, no production import)

| Mirror | Replaced by | Status / why it stays |
|---|---|---|
| `tests/crypto-vectors/argon2id-vectors.test.mjs` | KEK vectors + params: `packages/crypto-adapters/tests/libsodium-adapter.import.test.mjs` | **Keep** the XChaCha20-Poly1305 *encrypt* vectors: `libsodiumAdapter.encrypt` draws a random nonce by design, so a fixed-nonce known answer can only be produced by calling libsodium directly; its job is TS/Rust byte agreement with `native/crypto-core` |
| `tests/crypto-vectors/roundtrip.test.mjs` | `tests/acceptance/mirror-replacements.test.ts` (cipher-level describe) | superseded; tests AES-GCM, which production never uses |
| `tests/compatibility/chunk-manifest.test.mjs` | mirror-replacements (chunk-manifest describe), `packages/storage/tests/upload.real.test.mts` | superseded |
| `tests/compatibility/export-format.test.mjs` | mirror-replacements (export-format describe) | superseded and **stale**: it asserts "v1 export validates"; production rejects v1 (no key envelope) |
| `tests/end-to-end/export-import-roundtrip.test.mjs`, `export-import-relations.test.mjs` | `tests/acceptance/recovery-failures.test.ts` (E), `portable-backup.e2e.test.ts` | superseded; AES-GCM stand-in, v1 format |
| `tests/recovery/recovery-key.test.mjs` | mirror-replacements (recovery-key describe) | superseded; its third test (`serverCanRecoverWithoutKey = false`) is a constant and asserts nothing |
| `tests/sync-conflicts/conflict.test.mjs`, `sync-engine.test.mjs` | mirror-replacements (sync describe), `packages/sync/tests/*`, sync e2e | superseded |
| `tests/security/signin-client.test.mjs` | mirror-replacements (signin describe) + `tests/e2e-web/auth.spec.ts` | superseded |
| `tests/security/step-up-client.test.mjs` | window / `isStepUpRequired` / revocation copy: mirror-replacements; "must not run before step-up" + 403 re-prompt: e2e restore export, `mfa.spec.ts` (wrong code/cancel), security-center (server 403); recovery codes single-use: RSpec security_spec + `mfa.spec.ts`; revocation invariant: device-revocation acceptance | **Keep** only for the exact 65-key `security` i18n contract (mirror-replacements checks en/vi key equality, not the exact list) |
| `tests/security/reject-tampering-libsodium.test.mjs` | cipher cases: mirror-replacements; swap: recovery-failures K3 + sync-integrity swap | **Misleading**: "replay attempt is rejected (old revision presented as current)" and the envelope `version` check test an envelope with `revision` inside the plaintext that production does not have; the real behaviour is DEFECT-K3-rollback |
| `tests/security/tamper.test.mjs` | mirror-replacements (cipher), id-binding tests in recovery-failures / sync-integrity | AAD cases have no production counterpart (production AEAD uses null AD) |
| `tests/security/sync-replay.test.mjs` | stale base 409: RSpec `sync_spec.rb` + two-clients; checkpoint/replayed sequences: `packages/sync/tests/sync-client-queue.import.ts`; revoked/other-owner access: device-revocation acceptance + `items_spec.rb`; queue + manifest: mirror-replacements | **Describes features production lacks**: idempotency keys (no such field anywhere in API or client), "chose_remote … loser archived" resolution, and "revoked device" as an authorization check (the API checks the session only — see DEFECT-H2) |

Not in scope but also mirrors: `packages/sync/tests/sdk-wiring.test.mjs`,
`packages/storage/tests/wrapped-file-key.test.mjs`, `packages/schemas/tests/item-types.test.mjs`.

Superseded mirrors were not deleted: root `npm test` runs them and does not yet run
`tests/acceptance/`. Delete them once `test:acceptance` (below) is part of `npm test`.

## 4. Defects found (reproduced by the tests named)

| Id | Severity | Where | What happens | Reproduce |
|---|---|---|---|---|
| DEFECT-H1 | high | `apps/api/app/domains/authentication/passkeys.rb:195` | every passkey sign-in is bound to `user.devices.active.first`, whichever passkey (device) signed in; revoking "device B" revokes every session of the account, and the device list cannot tell browsers apart | device-revocation › "B's session is bound to a device record of its own" / "only B is cut off" |
| DEFECT-H2 | high | `passkeys.rb:195` + `apps/api/app/domains/devices/revoke.rb` | a revoked device signs straight back in with its passkey (a new device row is auto-enrolled) and pulls items created after the revocation; revoke touches neither the credential nor the vault key (clients never use key envelopes) | device-revocation › "the revoked device cannot sign in again…" |
| DEFECT-H3 | medium | `apps/desktop/src/sync/engine.ts:431`, `packages/sync/src/sync-client.ts:228` | a 401 on sync **pull** surfaces as raw `API 401 … {"error":"unauthorized"}` and never signs out; only a push 401 matches `/unauthorized \(401\)/` | device-revocation › "B's next SYNC call…" |
| DEFECT-H4 | medium | `apps/desktop/src/App.tsx:264-270` with `:1125` | after a 401 in the Security Center, "Continue without signing in (local vault only)" re-mounts the Security Center, whose next call 401s and resets `localOnlyBypass`: the user is thrown back to the sign-in gate until a reload | device-revocation › "Continue without signing in right after…" |
| DEFECT-C1 | high | `apps/desktop/src/sync/engine.ts:303-313` | a signed-in device whose local vault has a different vault key (user chose "Create vault" instead of "Restore" on a new device — the onboarding screen offers both) binds to the account's oldest server vault and pushes items no other device can decrypt; every other device's sync stays in error. The vault's `encrypted_name` is never decrypted as a key check | sync-integrity › "a device whose vault key cannot open the account vault refuses to push into it" |
| DEFECT-K3-rollback | high (security claim) | `packages/sync/src/index.ts` `applyRemoteEvents`; signatures stored but never verified (`apps/api/app/domains/sync/push.rb` header) | the server can serve an authentic older ciphertext as a newer revision; the client applies it silently (sync state idle). `specs/threat-model.md:10` lists rollback as defended by "AEAD, signed events, trusted checkpoints" | sync-integrity › "K3 rollback…" |
| DEFECT-K2-omission | medium | backup format (`packages/import-export/src/index.ts` `buildEncryptedExport`) | an item removed from a backup file restores "successfully" as N-1 items in all three apps; nothing authenticates the item list | recovery-failures › "a backup with one item silently removed is detected" (×3) |
| DEFECT-E1 | medium (data loss) | `apps/desktop/src/components/ItemForm.tsx:322` | opening any item with typed relations (has_login, has_card, owned_by, contains…) and pressing Save without changes rewrites every relation type to `related_to` | portable-backup › "editing a restored item…" |

Test problems found and fixed in `tests/` (not product defects):
- `tests/sync-e2e/conflict-ui.test.ts` hard-coded Vite on 5202 while the API's CORS/WebAuthn origin follows `SYNC_E2E_WEB_ORIGIN`: 3 of 4 tests timed out with any other origin (and could talk to a foreign server already on 5202).
- `tests/e2e-web-restore/restore.e2e.test.ts` fixed port 5203: now `E2E_RESTORE_WEB_PORT`.
- `tests/media-e2e/run.sh` ran `register.rb` under the machine's default Ruby (3.2 here): now defaults `RBENV_VERSION=3.3.6` like the other harnesses.

Observations (not defects): trash and media bytes are not part of a portable backup;
a corrupted `wrapped_recovery` cannot be detected by a passphrase restore (only
later, when the recovery key fails safely); `SyncEngine.scheduleRetry` still fires
after a later manual sync succeeded (one extra harmless sync).

## 5. Run against `main` (5717965), unmodified tests

The tests were copied onto a `git archive main` export (fresh `npm ci`); nothing else was changed.

- Module suites (`recovery-failures`, `mirror-replacements`): 48 tests, 45 pass, 3 todo — DEFECT-K2-omission still reproduces in all three apps.
- `portable-backup.e2e`: 4 pass; DEFECT-E1 still reproduces.
- `account-deletion`, `device-revocation`, `media-cross-device`, `sync-integrity`: blocked at account creation, so they say nothing about H/K/M/F on `main` yet. `main` now requires an emailed code + registration ticket before the passkey (`POST /v1/auth/passkeys/register` without `registration_ticket` → 401 `verification_failed`; web UI "Email me a code"), and binds sessions to devices only with an Ed25519 device proof (`specs/device-identity.md`). The harness must adopt `tests/e2e-web`'s mail-file code flow and the device-proof sign-in before these can run there.
- `main`'s own `npm run test:sync-e2e` fails 17/17 for the same reason: `tests/sync-e2e/client-worker.ts` `register` still calls `passkeyRegisterOptions(email)` without a ticket.

## 6. How to run

```sh
# fast, no services (real modules only): ~10 s
npx tsx --test tests/acceptance/recovery-failures.test.ts tests/acceptance/mirror-replacements.test.ts
# real stack (Postgres + Ruby 3.3 + Chromium; M also docker for MinIO)
npx tsx --test --test-concurrency=1 tests/acceptance/*.e2e.test.ts
```

Ports (env-overridable): H API 3253 / web 5365, K API 3254, M API 3255 /
web 5367 / MinIO 19701, F API 3256 / web 5369 / MinIO 19702, E web 5368. Databases `vault_{f,h,k,m}_a15_e2eauth`
are dropped and recreated by the tests. `ACCEPT_NO_DOCKER=1` skips only the
MinIO assertion of M and says so.
