# Release Readiness — acceptance criteria (Phase A, 17 Nov 2026)

> The master prompt's section 20 was not available verbatim to this audit.
> The criteria below are the release gates named in the task brief and in
> the repo's own README/specs, restated as checkable claims. Each is marked
> **PASS / FAIL / NOT VERIFIED** with the evidence on disk. Nothing has
> been built, tested, or run, so no criterion can pass on execution evidence.
>
> **Verdict: NOT READY FOR RELEASE. 0 of the 10 gates pass.**

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 1 | Passkey/WebAuthn verification is fully wired and verified end-to-end | **FAIL** | `passkeys.rb:38-47`: gem verify calls are comments; non-prod issues tokens without verification; prod raises. No `Authenticator` records, no sign-count. |
| 2 | One crypto stack, one parameter set, with known-answer vectors, consistent between TS and Rust | **FAIL** | TS libsodium INTERACTIVE vs Rust SENSITIVE (`crypto-core/src/lib.rs`); no KATs anywhere; Node tests exercise the AES-GCM reference, not libsodium. |
| 3 | Real iOS/Android credential-provider integration (AutoFill / Credential Manager) | **FAIL** | `native/ios-credential-provider/` and `native/android-credential-provider/` are EMPTY directories. Mobile has presence-only biometrics; Keychain/Keystore wrap is a plan README. |
| 4 | Extension autofill works with domain verification, least privilege, and no vault exposure to pages | **NOT VERIFIED** (code looks right) | `background.ts` + `domain.ts` + `content.ts` + `manifest.json` implement the design (HTTPS-only, subdomain/exact match, punycode/bank confirmation, on-demand injection, zero host permissions). Never built, loaded, or tested in Chrome. Wasm-in-MV3-worker path is explicitly unverified (`vite.config.ts` note). |
| 5 | End-to-end sync verified between two real devices through the Rails API | **FAIL** | `Sync::Pull` omits ciphertext so pull can never apply; no app imports `SyncClient`/`VaultApiClient`; no E2E harness exists (`tests/end-to-end/README.md` admits it). |
| 6 | Encrypted export / import round-trips portably; recovery works from a fresh device | **NOT VERIFIED** | Export/import v1 exists in all three client vaults (same format) but has only been exercised by Node tests that re-implement the logic with AES-GCM + a placeholder wrapped key — not by the real code. Server-side recovery is a stub (criterion 6's server half FAILs). |
| 7 | Sharing encryption (HPKE / verified key exchange) implemented, tested, and honest about revocation limits | **FAIL** | No HPKE anywhere; `Sharing::Create` accepts null `encrypted_key` and creates an ACTIVE share; no recipient keypair infrastructure. |
| 8 | Media encryption, upload, download, and streaming work end-to-end | **FAIL** | Chunk crypto + manifest helpers exist, but no File Key is stored (download undecryptable), no UI is wired (`MediaView` orphaned), chunk sizes disagree (1 MiB vs 8 MiB), and no blob has ever been uploaded. |
| 9 | Production deployment validated (Compose up, migrate, health, TLS, backups, restore) | **FAIL** | Compose + Caddy + docs exist but have never run; no `Gemfile.lock`; no CI; cloud is docs only; no backup/restore test. |
| 10 | External security audit completed (or at minimum a recorded audit plan with no Critical/High open) | **FAIL** | No audit. 2 Critical + 8 High open risks in `docs/security-review.md`. |

## Supporting gates (from the repo's own claims)

| Gate | Result | Evidence |
|---|---|---|
| Desktop app builds (`tsc && vite build`) | NOT VERIFIED | Never run. Tauri shell is unbuildable (only `tauri.conf.json`). |
| Mobile app runs (Expo Go / dev build) | NOT VERIFIED | Never run. WASM-in-Expo-Go path flagged as uncertain in mobile README. |
| Web client honours its "limited" banner (no plaintext export, no autofill, no upload) | **FAIL** | Plaintext export IS reachable via the shared desktop App; only autofill/upload claims hold. |
| `npm test` passes and tests the real code | **FAIL** | Tests mirror logic in-file; they cannot fail if the real modules break. (Also never run.) |
| `bundle exec rspec` passes | NOT VERIFIED | Never run; specs cover sync/items only. |
| `cargo test` passes | NOT VERIFIED | Never run. |
| No secrets committed; `.gitignore` adequate | PASS (on disk) | `.gitignore` covers env/keys/pem/db; no `.env` on disk; examples are placeholders. Git history not audited. |
| CVV/PIN never stored | PASS (code) | No such fields in any form/schema; detail view suppresses them. |
| No plaintext secrets in logs | PASS (code) | `filter_parameters` + audit-log discipline; runtime logs never observed. |

## Release blockers summary

- **Critical (2):** passkey verification unwired; no audit + nothing ever run.
- **High (8):** sync pull broken + unwired; web plaintext-export contradiction;
  Argon2id split; sharing without key exchange; server recovery stub;
  unencrypted local storage; signatures never verified; blob abuse + missing
  File Key store.
- Full ranked list with file:line evidence: `docs/implementation-status.md`.

---

# Phase G (hardening) + Phase H (release-candidate prep) — 17 Nov 2026

> This section was added by the Phase G/H agent. It does NOT change the
> Phase A verdict. **Verdict remains: NOT READY FOR RELEASE. 0 of the 10
> gates pass.** No gate changed state, because no gate's underlying defect
> was fixed — Phase G/H added CI, tests, docs, and checklists only. No app
> code was touched, nothing was built, tested, or run on the Mac, and CI
> has never executed.
>
> The distinction that matters below: **INTERNAL verification** (things
> this repo can check itself: CI, tests, docs) vs **EXTERNAL**
> (independent audit, store review, signing, hosted deployment). Nothing
> external exists, and nothing internal has ever run green.

## Gate re-assessment (Phase G/H)

| # | Criterion | Result after Phase G/H | What changed in Phase G/H |
|---|---|---|---|
| 1 | Passkey verification wired end-to-end | **FAIL** (unchanged) | None — app code out of scope. |
| 2 | One crypto stack, one parameter set, KATs | **FAIL** (unchanged) | None. New tests in `tests/security/` are AES-GCM mirrors, not libsodium KATs. |
| 3 | Real credential-provider integration | **FAIL** (unchanged) | None. Store prep (`docs/store-prep.md`) lists it as a blocker. |
| 4 | Extension autofill, domain verification | **NOT VERIFIED** (unchanged) | None. |
| 5 | E2E sync between two real devices | **FAIL** (unchanged) | None. New sync-replay tests mirror the intended rules only. |
| 6 | Encrypted export/import round-trip, recovery | **NOT VERIFIED** (unchanged) | New `tests/security/backup-corruption.test.mjs` mirrors format-v1 validation; real importer still unproven. |
| 7 | Sharing encryption (HPKE / key exchange) | **FAIL** (unchanged) | None. |
| 8 | Media encryption end-to-end | **FAIL** (unchanged) | New interrupted-upload tests mirror the chunk-manifest rules only. |
| 9 | Production deployment validated | **FAIL** (unchanged) | Deployment path is now DOCUMENTED (`docs/deployment.md`, `infra/docker/VALIDATION.md`, `infra/docker/.env.example` created) but still never run. Checklist exists; validation log (§9) is empty. |
| 10 | External security audit completed | **FAIL** (unchanged) | None. Audit plan still not recorded beyond this file; no auditor engaged. |

## New supporting gates (Phase G/H)

| Gate | Result | Evidence |
|---|---|---|
| CI exists (`.github/workflows/ci.yml`) | **CREATED — NEVER RUN** | Covers node tests, typecheck, production builds, Rust fmt/clippy/test, Rails RSpec, api Docker build, advisory audit. First run is expected to FAIL on the `lockfiles` job (no `package-lock.json`, no `Gemfile.lock`). |
| Security scanning (`.github/workflows/security.yml` + `.github/gitleaks.toml`) | **CREATED — NEVER RUN** | Gitleaks (working tree + weekly full history), dependency review, CodeQL (JS/TS + Ruby), cargo-audit. Git history has never been audited. |
| Security hardening tests (`tests/security/`) | **CREATED — NEVER RUN** | `tamper.test.mjs` (invalid/tampered/truncated ciphertext, wrong key, AAD binding, nonce uniqueness), `backup-corruption.test.mjs` (corrupted export, tampered payload, wrong wrapped key), `sync-replay.test.mjs` (replay, unauthorized access, keep-both conflict, offline recovery, interrupted upload). All MIRROR rules in-file; none import real code. Root `npm test` does NOT include them yet (root `package.json` out of scope) — run `node --test tests/security/` explicitly; CI does. |
| Deployment docs validated | **PARTIAL** | `docs/deployment.md` (checklist + run log, all NOT RUN), `infra/docker/VALIDATION.md` (9 static findings). Factual errors FIXED: `.env.example` created (it did not exist despite READMEs telling users to copy it); `mc mirror` backup command corrected; cloud README `force_path_style` claim corrected (code hardcodes it; R2 compatibility unverified). Exposed api/MinIO ports, missing CSP, weak S3 defaults remain open. |
| `.env.example` placeholders only | **PASS** | Created Phase G; all values are `CHANGE_ME_…` placeholders. `.gitignore` covers `.env` / `.env.*` (verified). |
| Store preparation (`docs/store-prep.md`) | **TODO — NOT SUBMITTED** | Full iOS + Play checklist; every item TODO. No developer accounts, signing, TestFlight/Play testing, or review. Account deletion NOT IMPLEMENTED (blocks both stores). |
| Privacy (`docs/privacy.md`) | **DRAFT — NOT PUBLISHED** | Privacy-by-design as implemented/planned, honestly marked. Not a legal policy; needs human + legal review and a hosted URL. |
| No secrets committed | **NOT VERIFIED** (was: PASS on disk) | Downgraded: on-disk check still holds, but git history has never been scanned. First history scan is the weekly gitleaks job — never run. |
| No CSP / headers on web | **FAIL** (unchanged) | Caddyfile + web still have no CSP (confirmed again in `infra/docker/VALIDATION.md`). |

## Internal vs external — what would move each gate

- **Internal only:** gates 2 (KATs), 4, 5, 6, 8, 9 can move with code
  fixes + observed green CI + observed deployment runs. None of that has
  happened yet.
- **External, human-controlled:** gate 10 (independent audit), store
  approval + signing (store-prep), hosted deployment on real
  infrastructure, and the published privacy policy. No agent can do
  these; they are not done and not scheduled.
- **Never label production-safe or audited:** nothing in this repo may
  be described that way until the gates above pass on observed evidence
  AND an external audit exists.

## New risks found in Phase G (not in Phase A)

- `infra/docker/.env.example` did not exist while two READMEs told users
  to copy it (fixed by creating it).
- Compose publishes api (3000) and MinIO (9000/9001) publicly, against
  the self-host README's own checklist (documented, not fixed — compose
  edits were out of the validation-only scope).
- `Blobs::StorageProvider` hardcodes `force_path_style: true` and
  defaults to weak credentials (`minio` / `minio123`); missing env vars
  fail late. The weak default is deliberately NOT allowlisted in
  gitleaks — if the scanner flags it, remove it from the code.
- The self-host README's `mc mirror` backup command could never have
  worked (no `mc` in the minio image).
- `docker compose down -v` in the restore procedure deletes all data;
  the README now warns explicitly, but the restore is still untested.

## Release blockers summary (updated)

- **Critical (2, unchanged):** passkey verification unwired; no audit +
  nothing ever run.
- **High (8, unchanged)** + new deployment hygiene blockers above.
- **New blocker:** account deletion not implemented (required by both
  stores before submission). 
- **Next action (highest priority):** generate + commit the lockfiles
  (`npm install`, `cd apps/api && bundle lock`), then run CI once and
  record the first (expected-red) result — that is the first piece of
  observed evidence this repo will ever have. Do not start store work
  before gates 1, 5, and 9 move.
