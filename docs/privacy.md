# Privacy — MY SECRET Personal Digital Vault (updated 17 Nov 2026)

> **STATUS: DRAFT — NOT A PUBLISHED PRIVACY POLICY. NOT LEGAL ADVICE.**
>
> This describes what the code does today. Each claim is marked:
> **VERIFIED (run)** — observed in a scripted run on 17 Nov 2026 (see
> `docs/deployment.md` §A.0 for commit, host and output);
> **CODE** — read in the code, not observed at runtime;
> **PLANNED / TODO / PENDING** — not built, or a human decision.
> A human must turn this into a published policy, and a lawyer should
> review it, before any store submission (PENDING, see §10).

## 1. Principles

- **Local-first.** The vault lives on the user's device. The server is an
  untrusted sync + blob store, not a trusted custodian.
- **End-to-end encryption.** Vault sync encrypts content on the device before
  it leaves. The server never receives decryption keys.
- **Optional AI import.** After explicit consent, the API forwards only the
  pasted text to OpenAI and returns an unsaved preview. My Secret does not
  retain the text or preview in storage or logs. OpenAI receives the request
  with response storage disabled. API inputs are excluded from training by
  default, and OpenAI may retain content in abuse monitoring logs, generally
  for up to 30 days. CSV import runs on the device.
- **Data minimisation.** The server stores what sync and sign-in need:
  ciphertext, opaque ids, revisions, timestamps, sizes, the account email,
  passkey public keys, and per-session metadata (below).
- **Mobile ads.** Free iOS and Android accounts may see non-personalized
  AdMob banners on the unlocked vault list. Vault data and keys do not go
  into ad requests.
- **No operator recovery.** No master key, no backdoor. Lost passphrase +
  lost recovery key = unrecoverable vault, by design; users must be told so.

## 2. What data exists, and where

| Data | Where | Protection | Status |
|---|---|---|---|
| Vault items (logins, notes, identities, keys, …) | Device + server (`item_versions.encrypted_payload` / `encrypted_item_key`) | Client-side libsodium encryption; format in `specs/encryption-format.md` | **VERIFIED (run)**: scenario L pushed 4 items; a fresh device restored the key envelope, pulled them from the server (also after a full backup/destroy/restore) and decrypted identical titles and fields; no plaintext marker appeared in any server log |
| Files / media | Server object storage (MinIO / S3 / R2), 1 MiB encrypted chunks via 5-minute presigned URLs; encrypted manifest in the `blobs` row | Per-file key wrapped by the Vault Key; the server never sees file name or type | **VERIFIED (run)**: 2.5 MiB file stored as 3 ciphertext chunks, restored, downloaded and decrypted with matching SHA-256 |
| Master passphrase, recovery key | User only; never sent | — | **CODE** (never in any request); **VERIFIED (run)**: neither value appeared in any container log |
| Account identity | Server: email (ownership proven by a mailed 6-digit code before the first passkey), passkey public key + credential id + sign counter, device public keys | WebAuthn + Ed25519 device proof; the server verifies every ceremony | **VERIFIED (run)**: code delivered over verified STARTTLS to a local test mail server and entered by the client; real attestation/assertion verified by the API (software authenticator; Chromium virtual authenticator in the CSP check) |
| Session metadata | Server `sessions`: token **digest**, expiry, user agent, IP address, step-up state | Raw token shown to the client once; TTL 1 h (`session_tokens.rb`) | **CODE**. Expired/revoked session rows are not purged until account deletion (TODO, §7) |
| Sync metadata | Server: item ids, revisions, timestamps, device ids, sizes | Plaintext metadata; content stays opaque | **CODE** |
| Audit events | Server `audit_events`: event type, small metadata (e.g. `{method: "totp"}`, counts), timestamps | No IPs, tokens or content in metadata | **CODE** |
| Request logs | Container stdout (Docker json-file, 5 × 10 MB per container, rotated) | One JSON line per request: method, path (opaque ids only, no query string), status, duration, request id. **No IP, no parameters, no headers, no bodies** | **VERIFIED (run)**: format observed; the log scan found no token, challenge, assertion, ciphertext, signature, passphrase, recovery key, marker or env secret in any container log |
| Reverse-proxy access logs | None (Caddy access logging is off) | — | **CODE** (`infra/docker/Caddyfile`) |
| Diagnostics / crash reports | Nowhere | — | **CODE**: no SDK integrated. PLANNED: opt-in only, if ever added |
| Mobile ads | Google AdMob on configured free mobile builds | Consent check and non-personalized banner requests | **CODE**. Google may process IP address, device information, ad interactions and SDK diagnostics. No vault or email fields are supplied to AdMob. |

## 3. Data minimisation in practice

- **VERIFIED (run)** — Server stores ciphertext only for items and files; the
  server-visible blob manifest is encrypted (no file name / MIME).
- **VERIFIED (run)** — Logs carry no request parameters, query strings,
  bodies or client IPs (`apps/api/config/initializers/logging.rb`), checked by
  `infra/docker/scan-logs.sh` against every value the client actually sent or
  received. Before 17 Nov 2026 Rails' default request log recorded the client
  IP and filtered parameters in a file inside the container.
- **CODE** — Presigned URLs expire after 300 s (`PRESIGN_TTL`).
- **CODE** — One bucket for all accounts (per-user storage deferred).
- **CODE** — The web client served by Caddy may only talk to its own origin
  and the S3 endpoint (CSP); no third-party hosts are contacted.

## 4. Telemetry, ads, third parties

- Google AdMob supplies mobile banners for Free accounts. The app requests
  non-personalized ads after checking Google UMP consent. The Settings ad
  privacy entry opens Google's choices when required. Pro removes banners.
- Apple and Google process mobile purchases. RevenueCat uses the account's
  opaque ID and store purchase records to verify access.
- Self-hosted: the operator's own Postgres, Redis and MinIO hold the data;
  Caddy contacts Let's Encrypt for certificates. The operator's **SMTP
  provider** receives the sign-up address and the 6-digit code (one email per
  sign-up attempt) — a processor to name in the policy; provider choice PENDING.
- Managed cloud (if used): the chosen Postgres/Redis/object-storage providers
  become processors — PENDING human decision and disclosure.

## 5. Account deletion — what, when, what the user sees

Endpoint: `DELETE /api/v1/auth/account` (`apps/api/app/controllers/api/v1/accounts_controller.rb`,
`apps/api/app/domains/accounts/delete.rb`). Behaviour **VERIFIED (run)** in
scenario L on 17 Nov 2026 unless marked CODE.

**Who / how.** Only the signed-in caller, after a fresh step-up (passkey or
TOTP within 10 minutes). Without it the API answers 403 (run). The request
ignores any user id in the body (CODE).

**When.** Synchronously, inside that one request. On success the API answers
204 and every session token of the account stops working at once (run: 401).
There is no grace period and no undo.

**What is deleted.**

1. Object storage first: every ciphertext chunk object of every blob in the
   account's vaults, any upload status, including chunks of unfinished uploads
   (their part rows exist from the upload session on). Run: bucket left with
   0 objects. If any object delete fails, **nothing in the database is
   deleted**, an `account_deletion_storage_failed` audit event (counts and
   error classes only) is written, the API answers 503 `storage_unavailable`
   and the user retries (CODE; covered by
   `apps/api/spec/requests/api/v1/account_deletion_storage_spec.rb`).
2. Then, in one database transaction: the user row, sessions, passkeys
   (authenticators), MFA secret and recovery codes, MFA/passkey/recovery/device
   challenges, sign-up email verifications, recovery verifiers, devices,
   device checkpoints, vaults, items, all item versions (ciphertext history),
   sync events, blobs and blob parts, key envelopes, identity key, and vault/
   item shares the account owns or receives. Run (18 Nov 2026): all 22 of
   these tables at 0 rows afterwards.
3. In the same transaction a **deletion tombstone** is written
   (`account_tombstones`: SHA-256 of the account id + deletion time, no email),
   plus one `[account_tombstone]` log line and an `account_deleted` audit
   event with no user and no metadata. They exist only so a later backup
   restore can re-apply the deletion (§5 "Backups"). Run: 1 tombstone row and
   1 log line.

**What remains on the server after deletion.**

- **Audit events** — kept, with `user_id` and `device_id` set to NULL
  (`User has_many :audit_events, dependent: :nullify`). They hold an event
  type, small metadata (method names, counts) and timestamps, no email, IP or
  content. Run: the account's audit rows remained, all unlinked. Retention:
  `RetentionJob` deletes audit events older than 1 year, **but nothing
  schedules that job** (no cron/scheduler in the repo), so today they stay
  until an operator runs it — TODO (§7).
- **Sync events in someone else's vault** made by the deleted account's
  devices keep the event with `device_id` NULL (CODE; sharing has no key
  exchange yet, so this does not arise in practice today).
- **Database files.** Deleted rows are gone logically at once; Postgres
  reuses their space later (autovacuum). Not readable through the app.
- **Logs.** Request lines (no IP, no email; opaque ids in paths) stay in the
  rotated container logs until rotated out or the containers are removed.
- **Object versions.** The compose MinIO bucket is unversioned, so a delete is
  final. If an operator enables **bucket versioning** (S3/R2), a delete only
  adds a delete marker: the ciphertext stays as a noncurrent version until a
  lifecycle rule expires it — PENDING operator decision (`infra/cloud/README.md`).
- **Deletion tombstones** — hashed account id + time, kept indefinitely (no
  retention rule yet — TODO §7). The id is a random UUID, so the hash cannot
  be linked to a person without a copy of the deleted row.
- **Backups.** Every backup made before the deletion still contains the whole
  account (DB rows and ciphertext chunks) **until that backup is deleted**.
  Run: restoring the pre-deletion backup brought the account and its blob
  back; following the restore runbook (`docs/deployment.md` §7: export
  tombstones before the restore, import + reapply after it, before serving)
  deleted it again, rows and objects. If an operator skips the runbook the
  account comes back. `backup.sh` has no rotation — PENDING (period, §7).

**Gaps found on 17 Nov 2026 and their state (18 Nov 2026, code read).**

- Chunk PUT with a still-valid presigned URL (300 s) after the deletion:
  **closed** — `OrphanBlobCleanupJob` now also deletes objects under
  `vaults/<vault>/blobs/<blob>/` whose blob row is gone, once older than the
  presign TTL, and the Sidekiq worker schedules it hourly at boot
  (`config/initializers/sidekiq.rb`; media e2e checks the schedule). Such a
  chunk can therefore survive up to about an hour.
- No record of a completed deletion: **closed** by the tombstones above.
- Development/test `Blobs.storage_provider` load order: **fixed** on main
  (commit 8143c0c, not re-run here).
- Still open: `RetentionJob` (audit events > 1 year, old versions of deleted
  items) is not scheduled; tombstones and expired sessions have no retention.

**What the user sees** (desktop and web Security Center; strings in
`packages/i18n/src/en.ts`): a "Delete account" card explaining that the server
account, its sessions and server-side vault data are deleted permanently and
that the vault on this device is **not** erased; a confirmation ("Delete this
server account permanently?"); a step-up prompt; then "Server account deleted.
Its sessions no longer work. The local vault on this device was not erased."
and the sign-in screen. On a storage failure the card shows the error and the
account stays. The **mobile app has no account-deletion UI** (no
`deleteAccount` call in `apps/mobile/src`) — a store blocker
(`docs/store-prep.md`). Erasing the local vault is a separate action
("wipe vault").

## 6. Data export

- **CODE** — Encrypted export/import (format v1, `packages/import-export`).
  The web client is built with `allowPlaintextExport={false}` (encrypted-only).
- Users should keep an encrypted export offline together with the recovery key.

## 7. Retention

| Data | Retention today | Status |
|---|---|---|
| Vault ciphertext + metadata | Until the user deletes the item/vault/account | CODE; deletion VERIFIED (run) |
| Deleted items (tombstones) | Tombstone + last version kept for sync; `RetentionJob` would prune older versions 90 days after deletion | Job **not scheduled** — TODO |
| Expired / revoked sessions (incl. IP, user agent) | Until account deletion | TODO: purge expired sessions after N days |
| Audit events | Unlinked at account deletion; `RetentionJob` would delete after 1 year | Job **not scheduled** — TODO |
| Account deletion tombstones (hashed id + time) | Indefinitely | TODO: keep at least as long as the oldest backup, then purge |
| Abandoned uploads, orphan objects | `OrphanBlobCleanupJob`, scheduled hourly by the worker | CODE; schedule checked by media e2e |
| Sign-up email verifications (email, code digest) | Until consumed/expired; deleted with the account | CODE; no purge of stale rows for addresses that never signed up — TODO |
| Container logs | Docker json-file, 5 × 10 MB per container, rotated; removed with the container | CODE (`docker-compose.yml`); time span depends on traffic |
| Server backups | Kept until the operator deletes them (no rotation in `backup.sh`) | PENDING: rotation period (e.g. 30 days) — this is the period to publish as "deleted data may persist in backups for up to N days" |
| Diagnostics | None collected | — |

## 8. Security practices relevant to privacy

- Keys never leave the device; the server holds no decryption key.
- Passkeys (WebAuthn) authenticate the account; they do not unlock the vault.
- TLS 1.2/1.3 only, HSTS, strict CSP for the web client, no third-party
  origins — VERIFIED (run, local CA). Real-domain certificates: PENDING.
- Only the reverse proxy is reachable from outside; database, cache and
  object storage sit on internal networks without internet access — VERIFIED (run).
- Rate limiting on auth/recovery (`rack_attack.rb`, CODE; per-process store).
- No external security audit — PENDING (human).

## 9. What users must be told (published policy)

1. We cannot recover your vault if you lose both your passphrase and your
   recovery key. No one can.
2. Vault sync sends ciphertext and sync metadata.
3. Free mobile accounts may see non-personalized AdMob banners. Explain the
   provider's data use, consent controls and the ad-free paid option.
4. You can export your encrypted vault and delete your account in the app
   (desktop/web today; mobile PENDING). Deletion is immediate and permanent on
   the live server; it does not erase the vault on your device.
5. Backups made before your deletion keep your (encrypted) data until they
   are rotated after **[PENDING: N] days**.
6. The server records, per session, the IP address and browser/app name, kept
   until **[PENDING: purge period]**.

## 10. Open items before this can be published

- [ ] PENDING (human): set backup rotation, session-purge and audit-retention
      periods; schedule the existing jobs; write the post-restore re-deletion
      procedure.
- [ ] PENDING (code owners): the account-deletion gaps in §5.
- [ ] PENDING (mobile): in-app account deletion.
- [ ] PENDING (human + lawyer): legal review; publish at a public URL; link
      from both store listings and from inside the app.
- [ ] PENDING (human): verify privacy-label / data-safety answers against real
      network behaviour of the shipped mobile builds.
