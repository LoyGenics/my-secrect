# infra/docker — validation status (17 Nov 2026)

What was RUN, on one macOS arm64 host (Docker Desktop 28.5.1, Compose 2.40.0),
local stack only (`SITE_ADDRESS=localhost`, Caddy internal CA), with the
test-only override `docker-compose.test.yml` (Mailpit as SMTP server, per-run
CA). Full output summaries: `docs/deployment.md` §A (A.5 = latest) and §9.

| Script | What it proves | Last run | Result |
|---|---|---|---|
| `verify-restore.sh` | Scenario L: fresh project + volumes -> deploy -> migrate -> hardening checks -> real client (email code from the test mail catcher, WebAuthn account + device key, vault, 4 encrypted items, encrypted media blob) -> restart all -> fresh device decrypts -> backup -> export tombstones -> `down -v` -> restore -> import + reapply tombstones -> identical table/object fingerprints -> fresh device (recovery key) decrypts everything -> account deletion (what goes/stays) -> pre-deletion backup restored + tombstones reapplied deletes it again -> log secret scan | 17 Nov 2026 21:36 UTC, `dd2573d` | PASS |
| `verify-web-csp.sh` | Built `apps/web` served by Caddy runs sign-up with the mailed code, passkey registration, vault creation (wasm), encrypted media upload/preview/download, Security Center, reload/unlock under the strict CSP with 0 violations; inline-script negative control blocked + reported; headers | 17 Nov 2026 21:37 UTC, `dd2573d` | PASS |
| `scan-logs.sh` | No client-observed secret, env secret or pattern (session token, presigned signature/credential, bearer, PEM key, marker, unfiltered sensitive param, Rails `Parameters:` line) in any container log; positive control | inside both runs above | PASS |
| `smoke.sh` | Email sign-up + device proof, WebAuthn registration, blob round trip via public `s3.<site>`, CORS, forged signature refused, step-up + account deletion, object gone | 17 Nov 2026, `dd2573d` (project `a16-smoke`) | PASS |
| `tests/media-e2e/run.sh` | Real crypto/storage pipeline through Caddy + MinIO: two devices, resume, retries, tamper cases, 96 MiB streaming, worker-scheduled orphan sweep | 17 Nov 2026, `dd2573d` (project `a16-media`) | PASS 17/17 |
| `E2E_BROWSER=1 tests/media-e2e/run.sh` | Shared MediaView in Chromium against the stack | 17 Nov 2026, `dd2573d` (project `a16-mediab`) | PASS |
| `backup-restore-proof.sh` | SQL-seeded rows + one object survive destroy/restore | 17 Nov 2026, `feat/deploy-e2e` | PASS (superseded by scenario L) |

## Earlier static findings (Phase G) — current state

| # | Finding | State | Evidence |
|---|---|---|---|
| 1 | api/MinIO ports published on the host | FIXED: only Caddy publishes; internal `proxy`/`backend` networks; MinIO console off | scenario L step 3 |
| 2 | No CSP anywhere | FIXED: strict CSP for the web build, `default-src 'none'` for the API, sandbox CSP for S3 | `verify-web-csp.sh` |
| 3 | `mc mirror` instructions wrong | SUPERSEDED: `backup.sh` / `restore.sh` | scenario L steps 6-8 |
| 4 | R2 path-style unverified | OPEN (not run against R2) | `infra/cloud/README.md` |
| 5 | No lockfiles | FIXED: `package-lock.json` and `apps/api/Gemfile.lock` committed, CI `lockfiles` job | git |
| 6 | Missing env vars fail late; weak defaults | FIXED: compose `${VAR:?}` + production boot check (placeholder/short/`*`/missing) | scenario L steps 1, 3 |
| 7 | Caddy proxies before Rails is ready | FIXED: `depends_on: api: service_healthy` | scenario L step 2 |
| 8 | Worker env incomplete | FIXED: shared env anchor; worker healthcheck (Sidekiq heartbeat) | scenario L step 2 |
| 9 | Restore never tested | FIXED for one host / same versions | scenario L steps 6-9 |

## Not verified (open)

- Real domain, Let's Encrypt issuance, real DNS for `s3.<domain>` — PENDING (human).
- A real SMTP provider (only Mailpit with a throwaway CA was used) — PENDING (human).
- Managed cloud / R2 / AWS S3; egress for api/worker when storage is external.
- Off-host encrypted backups, restore on a different host or Postgres/MinIO
  version, large data sets, RTO/RPO, upgrade/rollback, load and sizing.
- Image digests are not pinned (MinIO/mc use `:latest`); the API image runs as
  root (`apps/api/Dockerfile` has no `USER`); Redis has no password (only on
  the internal `backend` network).
- `/health` is liveness only (Rails answers), not a dependency readiness check.
