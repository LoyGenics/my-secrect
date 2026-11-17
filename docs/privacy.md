# Privacy — MY SECRET Personal Digital Vault (Phase H, 17 Nov 2026)

> **STATUS: DRAFT — NOT A PUBLISHED PRIVACY POLICY.**
>
> This document describes privacy by design **as implemented or planned**
> in the code as read on 17 Nov 2026. Each claim is marked
> IMPLEMENTED (code read) / PLANNED (designed, not built) / UNVERIFIED
> (code exists but never ran). It is **not legal advice** and **not the
> hosted privacy policy** the stores require — a human must turn it into
> a published policy (and ideally have a lawyer review it) before any
> store submission. See `docs/store-prep.md`.
>
> Nothing in this document has been verified by running the app.

## 1. Principles

- **Local-first.** The vault lives on the user's device. The server is
  an untrusted sync + blob store, not a trusted custodian.
- **End-to-end encryption.** Vault content is encrypted on the device
  before it leaves it. The server never sees plaintext or decryption keys.
- **Data minimisation.** The server stores only what sync needs:
  ciphertext, item ids, revisions, timestamps, sizes — no plaintext
  titles, usernames, passwords, notes, or file contents.
- **No ads, no trackers.** No ads SDKs, no third-party analytics, no
  cross-app tracking. Diagnostics (if any) are opt-in only.
- **No recovery by the operator.** There is no backdoor, no master key,
  no password reset that can reveal vault content. A lost passphrase +
  lost recovery key means the vault is unrecoverable — by design, and
  the user must be told so.

## 2. What data exists, and where

| Data | Where | Encryption | Status |
|---|---|---|---|
| Vault items (passwords, notes, files) | Device (encrypted SQLite / local store) + server as ciphertext | Argon2id-derived key + XChaCha20-Poly1305 (libsodium, desktop/mobile); AES-GCM + PBKDF2 in the web reference adapter | IMPLEMENTED (code read) — **but** the Argon2id parameter set differs between TS (INTERACTIVE) and Rust (SENSITIVE): gate 2 FAIL; and local storage is reported unencrypted in Phase A (High risk) — see §6 |
| Master passphrase | User's memory only; never stored, never sent | — (derived key only) | IMPLEMENTED (design) / UNVERIFIED (runtime) |
| Recovery key | User-held (offline storage recommended) | — | IMPLEMENTED (code) / UNVERIFIED (runtime) |
| Account identity (passkey) | Server: public key + credential id; device: private key in platform authenticator | WebAuthn | PLANNED — verification is NOT wired (gate 1 FAIL); non-prod issues tokens without verification |
| Sync metadata (ids, revisions, timestamps, device ids) | Server Postgres | Plaintext metadata (ciphertext stays opaque) | IMPLEMENTED (code read) |
| File blobs (encrypted chunks) | Server MinIO/R2/S3 via 5-min presigned URLs | Client-side chunk encryption; server never sees plaintext | IMPLEMENTED (code) / UNVERIFIED — no blob has ever been uploaded; File Key storage missing (gate 8 FAIL) |
| Audit log (who did what, when) | Server | Metadata only — no plaintext secrets in logs (`filter_parameters` + audit-log discipline) | IMPLEMENTED (code) / UNVERIFIED (runtime logs never observed) |
| Diagnostics / crash reports | Nowhere by default | — | PLANNED — opt-in only; no SDK integrated |
| Advertising / tracking data | Nowhere | — | IMPLEMENTED — no ads SDKs in any `package.json` (verified by reading) |

## 3. Data minimisation (as implemented)

- IMPLEMENTED — Server stores ciphertext only; sync pull/push carry
  encrypted payloads (except gate 5: pull currently OMITS ciphertext —
  a functional bug, not a privacy leak, but it means sync does not work).
- IMPLEMENTED — No CVV/PIN fields anywhere in forms or schemas; the
  detail view suppresses them (Phase A).
- IMPLEMENTED — Presigned blob URLs expire in 5 minutes
  (`PRESIGN_TTL = 300`, code-read).
- UNVERIFIED — Whether the API logs request bodies or URLs that could
  contain sensitive metadata; `filter_parameters` covers Rails params,
  but runtime logs have never been observed.
- PLANNED — Per-user storage isolation is deferred (code comment in
  `Blobs::StorageProvider`); one bucket today.

## 4. Telemetry, ads, third parties

- **No ads SDKs.** None in any `package.json` (desktop/web/extension/
  mobile) as read 17 Nov 2026.
- **No third-party analytics.** No analytics SDK in any app.
- **Opt-in diagnostics only (PLANNED).** If diagnostics are ever added:
  explicit opt-in, no vault content, no identifiers beyond what is
  needed to debug, and a visible toggle to turn them off. Nothing is
  implemented today — there is nothing to opt out of.
- **Third-party services the server touches:** object storage (MinIO /
  R2 / S3) holds ciphertext blobs; Postgres/Redis hold metadata +
  ciphertext. No other processors are integrated.

## 5. Account deletion

- **Status: NOT IMPLEMENTED (blocker for both stores).** The API has no
  delete-account endpoint (routes cover devices, vaults, items, sync,
  blobs, shares, recovery only). Apple and Google both require
  in-app account deletion for apps with account creation.
- **Required behaviour (PLANNED):** in-app "Delete my account" that
  deletes the account, all vaults, ciphertext, blobs, and devices
  server-side; deletes the local vault on the device; and confirms
  deletion. A web deletion-request link is also required by Google Play.
- **Retention after deletion:** server backups may retain ciphertext
  until the backup cycle rotates — that must be stated in the published
  policy with a concrete retention period (TODO: set one).

## 6. Data export

- **Status: IMPLEMENTED (code) / UNVERIFIED (runtime).** Encrypted
  export/import format v1 exists in desktop, mobile, and web
  (`packages/import-export`) and is exercised only by mirror tests
  (gate 6). Export is encrypted; there is no plaintext export path in
  the export format itself.
- **Contradiction (open):** Phase A found plaintext export IS reachable
  via the shared desktop App despite the web client's "limited" banner
  claim. This must be resolved before the export story is told to users
  or reviewers.
- **User guidance:** export regularly, store the export offline, and
  keep the recovery key with it — the export alone is useless without
  the key, and the key alone is useless without the export.

## 7. Retention

| Data | Retention (as designed) | Status |
|---|---|---|
| Vault ciphertext + metadata | Until the user deletes the vault/account | IMPLEMENTED (code) / UNVERIFIED |
| Deleted items (tombstones) | Kept as tombstones for sync; no defined expiry | PLANNED — no retention policy set; TODO |
| Orphan blobs | Cleanup job (Sidekiq) — designed, schedule unverified | PLANNED / UNVERIFIED |
| Audit logs | No defined retention period | TODO — set one before launch |
| Server backups | Until the backup cycle rotates (no cycle defined) | TODO — define + test restores |
| Diagnostics (if ever added) | Opt-in only; retention TBD | PLANNED |

## 8. Security practices relevant to privacy

- Keys never leave the device; the server never holds a decryption key.
- Passkeys (WebAuthn) separate account auth from vault unlock —
  PLANNED, verification unwired (gate 1).
- Rate limiting on auth + recovery endpoints (`rack-attack` — code
  read, never observed).
- Session TTLs and device revocation — designed; enforcement unverified.
- No CSP on web / Caddy yet (Phase A + `infra/docker/VALIDATION.md`).
- No external security audit (gate 10 FAIL).

## 9. What users must be told (for the published policy)

1. We cannot recover your vault if you lose your passphrase and
   recovery key. No one can — not us, not the server host.
2. We collect no vault content. The server sees ciphertext and sync
   metadata only.
3. No ads, no tracking, no sale of data. Diagnostics are opt-in only.
4. You can export your encrypted vault at any time and delete your
   account (once the deletion flow is implemented — it is not yet).
5. Backups of the server contain ciphertext + metadata and are kept
   for [TODO: period] before rotation.

## 10. Open items before this can be published

- [ ] Resolve the plaintext-export contradiction (§6).
- [ ] Implement account deletion (§5) + set retention periods (§7).
- [ ] Verify the privacy-label / data-safety answers against real
      network behaviour (no hidden analytics, no unexpected hosts).
- [ ] Human + legal review; publish at a public URL; link it from both
      store listings and from inside the app.
