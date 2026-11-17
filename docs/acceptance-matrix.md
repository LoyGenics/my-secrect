# Release acceptance matrix

Independent verification by QA (Agent 15). State of **`main` (176779b)**,
verified on branch `test/acceptance-main` (main + the acceptance suites),
2026-11-18. The first pass ran on `integrate/wave0` (branch
`test/acceptance`); §5 records what changed between the two. Every status
below comes from a suite that was **run**, not from a status doc or commit
message. "Real" means the test imports or drives production code
(packages/*, apps/*, the Rails API, Chromium); "mirror" means the rule is
re-implemented inside the test file.

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
| G | Secure sharing | **covered by the sharing suites; partly re-run here** — UI spec 1/1 run; `tests/sharing-e2e/two-users.test.ts` not run by QA (its harness only accepts an `_agent10` database) | — |
| H | Device revocation | **partial** — each session bound to its own device key (H1 fixed on main), revoked sessions die everywhere, offline copy honest, device + passkey removal keeps a device out; revoking the device alone is not durable | DEFECT-H2, H3, H4 |
| I | Browser autofill with origin checks | **covered** | — |
| J | Native credential providers | **pending** (another agent) | — |
| K | Recovery failure (wrong credentials, corrupted backup, tampered ciphertext) | **covered** with known defects | DEFECT-K2-omission, DEFECT-K3-rollback |
| L | Deploy / restore | **blocked** — the compose stack cannot boot the API on main | DEFECT-L1 |
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

### G — Secure sharing
| Test | Proves | Real? |
|---|---|---|
| `tests/sharing-e2e/ui.spec.ts` › A shares an item read-only with B through the UI; B verifies, accepts, opens; A revokes | two Chromium users, real passkeys, fingerprint comparison, accept, open, revoke | real (run by QA: 1/1) |
| `tests/sharing-e2e/two-users.test.ts` (10 tests: identity keys, key substitution, read-only/write shares, tamper, revoke erases ciphertext, no plaintext stored) | | real (written by the sharing agent; **not run by QA**: its harness refuses any database not ending in `_agent10`) |
| `packages/core/tests/sharing-proposal.test.mjs`, `apps/api/spec/requests/api/v1/shares_spec.rb` | | real |

### H — Device revocation
| Test | Proves | Real? |
|---|---|---|
| `tests/acceptance/device-revocation.e2e.test.ts` › revoking B's device: B's token is refused on every route | vaults, sync pull/push, key envelopes, devices, sessions, blobs all 401 | real |
| same › B's browser returns to sign-in on its next account call ("session expired"); the encrypted vault stays on the device | honest limit: revocation is not a remote wipe | real (Chromium) |
| same › honest offline limit: after a reload the revoked browser still opens and reads its local vault with no session | | real |
| same › B's session is bound to a device record of its own (its device key) / only B is cut off: A's session keeps working (and syncing) | each browser's session is bound to its own Ed25519 device row; revoking B leaves A signed in and syncing (was DEFECT-H1 on integrate/wave0) | real |
| same › the revoked device cannot sign in again … | **DEFECT-H2** (todo): B signs in again on a freshly enrolled device and pulls the post-revocation item | real |
| same › complete cut-off: revoking B's device AND removing B's passkey keeps B out for good | the working path to a durable cut-off today | real |
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

### L — Deploy / restore: blocked
`infra/docker/backup-restore-proof.sh`, `verify-restore.sh` and `smoke.sh` exist on main but all boot
the compose stack, whose API now refuses to start (DEFECT-L1); `tests/media-e2e/run.sh` fails the
same way. Not run further by QA.

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
| ~~DEFECT-H1~~ | fixed on main | was `passkeys.rb:195` on integrate/wave0 | every sign-in was bound to `user.devices.active.first`. On main a session is bound only through an Ed25519 device proof; verified by device-revocation › "B's session is bound to a device record of its own" and "only B is cut off" (both now plain passing tests) | — |
| DEFECT-H2 | high | `apps/api/app/domains/authentication/device_proof.rb:130` (enrol path of `device_for!`) + `apps/api/app/domains/devices/revoke.rb` | a revoked browser signs straight back in with the same passkey: its revoked device key is replaced by a newly enrolled one, and it pulls items created after the revocation. Revoke touches neither the passkey nor the vault key. Removing the passkey as well does keep it out | device-revocation › "the revoked device cannot sign in again…" |
| DEFECT-H3 | medium | `apps/desktop/src/sync/engine.ts:448`, `packages/sync/src/sync-client.ts:229` | a 401 on sync **pull** surfaces as raw `API 401 … {"error":"unauthorized"}` and never signs out; only a push 401 matches `/unauthorized \(401\)/` | device-revocation › "B's next SYNC call…" |
| DEFECT-H4 | medium | `apps/desktop/src/App.tsx:230-238` with the SecurityCenter `onUnauthorized` at `:1060` / `:1087` | after a 401 in the Security Center, "Continue without signing in (local vault only)" re-mounts the Security Center, whose next call 401s and resets `localOnlyBypass`: the user is thrown back to the sign-in gate until a reload | device-revocation › "Continue without signing in right after…" |
| DEFECT-L1 | high (deploy blocker) | `infra/docker/docker-compose.yml` (no `SMTP_*` / `MAIL_FROM` passed to `api`), `tests/media-e2e/run.sh` env file; check at `apps/api/config/initializers/action_mailer.rb:44-48` | in production mode the API refuses to boot (`AuthMailDelivery::ConfigurationError: production requires SMTP … missing: SMTP_ADDRESS, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM`), so the compose stack never becomes healthy | `E2E_PROJECT=a15media … tests/media-e2e/run.sh --keep`, then `docker logs a15media-api-1` |
| DEFECT-C1 | high | `apps/desktop/src/sync/engine.ts:307-317` | a signed-in device whose local vault has a different vault key (user chose "Create vault" instead of "Restore" on a new device — the onboarding screen offers both) binds to the account's oldest server vault and pushes items no other device can decrypt; every other device's sync stays in error. The vault's `encrypted_name` is never decrypted as a key check | sync-integrity › "a device whose vault key cannot open the account vault refuses to push into it" |
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

## 5. integrate/wave0 → main: what changed (re-verified on main 176779b)

`main` added email-verified sign-up (code → registration ticket → passkey)
and Ed25519 device keys (`specs/device-identity.md`). The harness follows:
`lib/stack.ts` gives the API `MAIL_FILE_DIR` and reads the mailed code,
`lib/browser.ts` registers through "Email me a code", and Node devices get
`MAIL_DIR` so `tests/sync-e2e/client-worker.ts` enrols and binds its device
key. M additionally checks main's new tables (`device_challenges`,
`email_verifications`, `identity_keys`, `item_shares`).

- **Fixed on main:** DEFECT-H1 (both H1 tests are now plain passing tests).
- **Still reproduce on main:** DEFECT-H2 (now through device re-enrolment), H3, H4, C1, K3-rollback, K2-omission (desktop, extension, mobile), E1.
- **New on main:** DEFECT-L1 (compose API cannot boot without SMTP settings).
- An earlier run on main 5717965 stopped at account creation; at that commit main's own `test:sync-e2e` also failed 17/17 (client-worker registered without a ticket). Fixed on main by a1194f2.

Suites run on `test/acceptance-main` (main 176779b + these suites):

| Suite | Result |
|---|---|
| `npm run test:acceptance` | 48 tests: 45 pass, 3 todo (K2-omission ×3) |
| `npm run test:acceptance:e2e` | 31 tests: 25 pass, 0 fail, 6 todo (H2, H3, H4, C1, K3-rollback, E1) |
| `npm test` | mirrors 31/31, test:real 135/135 |
| `node --test tests/security/` | 61/61 |
| RSpec | 270 examples, 0 failures, 3 pending |
| `cargo test` (crypto-core) | 20/20 |
| `test:e2e:web` | 19/19 |
| `test:sync-e2e` | 21/21 |
| extension e2e | 42/42 |
| web restore e2e / extension restore e2e | 5/5, 5/5 |
| sharing UI (`tests/sharing-e2e/playwright.config.ts`) | 1/1 |
| `test:media-e2e` | **cannot start**: the compose API refuses to boot (DEFECT-L1) |

## 6. How to run

```sh
npm run test:acceptance       # module suites, no services: ~10 s
npm run test:acceptance:e2e   # real stack: Postgres + Ruby 3.3 + Chromium; M and F also docker (MinIO)
```

Ports (env-overridable): H API 3253 / web 5365, K API 3254, M API 3255 /
web 5367 / MinIO 19701, F API 3256 / web 5369 / MinIO 19702, E web 5368. Databases `vault_{f,h,k,m}_a15_e2eauth`
are dropped and recreated by the tests. `ACCEPT_NO_DOCKER=1` skips only the
MinIO assertion of M and says so.
