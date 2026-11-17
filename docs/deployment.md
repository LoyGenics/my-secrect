# Deployment — MY SECRET Personal Digital Vault

> **VALIDATION STATUS (17 Nov 2026, branch `feat/deploy-hardening`)**
>
> Everything marked **[RUN]** was executed by a script on ONE developer Mac
> (macOS 26.6.1 arm64, Docker Desktop 28.5.1, Compose 2.40.0) against a
> throwaway local stack (`SITE_ADDRESS=localhost`, Caddy's internal CA). Script
> output is summarised in §A. Nothing here has been deployed to a real domain,
> a public CA, a cloud provider or production; no external audit exists.
> Human-controlled steps are listed in §11 as **PENDING**.

## A. Evidence-backed results [RUN]

Images: `caddy:2-alpine` (Caddy v2.11.9), `postgres:16-alpine`,
`redis:7-alpine` (7.4.12), API image built from `apps/api/Dockerfile`
(ruby 3.3.13, Rails 7.2.3.2), MinIO `cgr.dev/chainguard/minio:latest`
(RELEASE.2026-11-16) and `cgr.dev/chainguard/minio-client:latest`.

### A.0 Scenario L — `infra/docker/verify-restore.sh` -> PASS (exit 0)

Run 17 Nov 2026 16:50 UTC, commit `0ae3151`, 1 min 43 s. One command:
`infra/docker/verify-restore.sh`. It creates its own compose project
(`a16-scenl`, ports 19543/19580) with random secrets, starts from zero
volumes, and fails on any mismatch. Observed:

1. Compose refuses an environment without the required variables.
2. Deploy: `up --build`, `rake db:migrate` (3 up, 0 down); api healthy,
   worker healthy (Sidekiq heartbeat), Caddy serves `/health` over TLS.
3. Hardening (see §B):
   - API boot refused for `SECRET_KEY_BASE=CHANGE_ME`, a 16-char
     `SECRET_KEY_BASE`, empty `REDIS_URL`, `CORS_ORIGINS=*`, empty `S3_BUCKET`
     (each error names the variable);
   - only `caddy` has published ports; `proxy` and `backend` networks are
     internal; Caddy reaches `api:3000` but not `db:5432`/`redis:6379`; the
     api container cannot reach the internet;
   - TLS 1.3 and 1.2 accepted, 1.1 and 1.0 refused; plain HTTP -> 308;
   - API responses carry HSTS, nosniff, `X-Frame-Options: DENY`,
     `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
     `CSP: default-src 'none'…` exactly once each, no `Server` header;
     unauthenticated `/api/v1/vaults` -> 401.
4. A REAL client (`verify-restore/client.ts`: the desktop vault module with
   libsodium, the desktop SyncEngine + SDK, the shared media pipeline, a
   WebAuthn software authenticator whose ceremonies the API verifies; TLS
   verified against Caddy's root CA) registers an account, creates a vault,
   pushes 4 encrypted items and uploads a 2.5 MiB file as 3 encrypted chunks
   through `https://s3.localhost:19543`.
5. `docker compose restart` of every service; a FRESH device (empty storage)
   restores the vault key envelope with the passphrase, signs in with the
   passkey, pulls and decrypts 4/4 items (titles + fields identical) and
   downloads + decrypts the blob (SHA-256 identical).
6. Fingerprint (21 tables, 35 rows; per table row count + md5 over the rows'
   text form, so ciphertext bytes are included; 3 objects with sha256), then
   `backup.sh` (pg_dump -Fc + `mc mirror` + sha256 manifest, 4 files).
7. `docker compose down -v`: 0 project volumes left; a fresh Postgres has 0 tables.
8. `restore.sh --yes` (manifest verified, `pg_restore --clean`, `mc mirror`),
   then the full stack again (new Caddy CA, re-trusted by the client).
9. Every table: same row count + md5; every object: same key + sha256.
10. Another fresh device restores the key envelope with the **recovery key**,
    signs in with the passkey (sign counter checked against the restored
    row), decrypts 4/4 items and the blob. The pre-backup session token is
    still accepted.
11. Account deletion: 403 without step-up, 204 after a passkey step-up;
    every session token -> 401; 18 account tables at 0 rows; bucket 0
    objects; 6 audit events kept with `user_id`/`device_id` NULL. The
    pre-deletion backup still contains the account.
12. Restoring that backup brings the deleted account back (users=1, 3 objects)
    — see `docs/privacy.md` §5.
13. Log scan (`scan-logs.sh`) over 423 lines from all 7 containers, before
    the destroy and after the restore: 126 fixed needles (every token,
    WebAuthn challenge/assertion, ciphertext field, encrypted manifest,
    presigned signature, the passphrase, recovery key and plaintext markers
    the client saw, plus the env secrets) + 8 pattern rules -> no match;
    48 structured request lines present.

Not covered: real domain + public CA, off-host backup copies, backups of a
large data set, restore onto a different host or Postgres/MinIO version,
timing (RTO/RPO), upgrade/rollback.

### A.1 Web client under the strict CSP — `infra/docker/verify-web-csp.sh` -> PASS (exit 0)

Run 17 Nov 2026 16:50 UTC, commit `0ae3151`, 37 s. Builds `apps/web`
(`tsc && vite build`; `index.html` has no inline script), boots project
`a16-csp` (ports 19544/19581) with Caddy serving the build read-only, then:

- Headers: document CSP enforced (1x, not report-only), HSTS, XFO DENY,
  nosniff, no-referrer, COOP + CORP same-origin, `no-cache`; `/assets/*`
  immutable, missing asset -> 404; `s3.<site>` -> sandbox CSP.
- Chromium (Playwright, `verify-web-csp/browser.mjs`) drives the built app:
  passkey account registration (CDP virtual authenticator, verified by the
  API) -> vault creation (libsodium WebAssembly) -> encrypted media upload to
  the S3 endpoint -> thumbnail decrypted from a `blob:` URL -> decrypted
  download (bytes identical) -> Security Center -> lock, reload, unlock.
- **CSP violations during the flow: 0 events, 0 console messages, 0 uncaught
  page errors.** Negative control: an injected inline `<script>` was blocked
  and reported (1 event, 1 console line), so the detector works.
- Log scan of all containers: clean.

The policy (from `infra/docker/Caddyfile`, `S3_PUBLIC_ENDPOINT` substituted):

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' blob:; media-src 'self' blob:; font-src 'self';
connect-src 'self' https://s3.<site>; manifest-src 'self'; worker-src 'self';
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'
```

`'wasm-unsafe-eval'` is needed only for libsodium's WebAssembly; there is no
`unsafe-inline` and no `unsafe-eval`. Not adopted: `require-trusted-types-for`
(the shared desktop UI renders markdown HTML via `dangerouslySetInnerHTML`, which a Trusted Types policy would have to cover first).

### A.2 Regression runs on the hardened stack -> PASS

Re-run 17 Nov 2026 at commit `0ae3151` with `a16-*` project names (ports
19546/19583 and 19547/19584), `RBENV_VERSION=3.3.6` for the Ruby helpers:
`tests/media-e2e/run.sh` 9/9 and `infra/docker/smoke.sh` PASS (details in §9).
The internal networks, Caddy header changes and the production boot check did
not break presigned uploads, MinIO CORS, WebAuthn or account deletion.

### A.3 Earlier runs (historical)

- 17 Nov 2026, branch `feat/deploy-e2e`: `smoke.sh` and
  `backup-restore-proof.sh` (SQL-seeded rows + one random object; superseded
  by scenario L, which uses a real client and checks decryptability).
- Problems those runs found and fixed: Dockerfile ran the Rails generator
  instead of Puma; `rails/all` aborted production boot; Sidekiq/connection_pool
  crash; no ActiveJob adapter; `SECRET_KEY_BASE` (not `RAILS_MASTER_KEY`) is
  what Rails needs; Docker Hub MinIO images unavailable (Chainguard defaults);
  weak S3 defaults removed; Caddy waits for api health; worker gets S3 env.
- Since then (media wiring): presigned URLs are signed for the public
  `S3_PUBLIC_ENDPOINT` (`https://s3.<site>`, routed by Caddy), so browsers and
  apps outside the Docker network can upload/download.

### A.4 Found by today's runs and fixed

- Production Rails logged to `log/production.log` inside the container (not
  visible in `docker logs`), with the client IP and filtered parameters on
  every request. Now: stdout, one JSON line per request without IP,
  parameters, query string or body.
- `encrypted_metadata` / `encrypted_manifest` were not in `filter_parameters`
  (they would have been printed in a parameters log line). The list is now a
  broad partial match (`crypt`, `_key`, `token`, `credential`, …) and
  production does not log parameters at all.
- Caddy advertised HTTP/3 on UDP 443, which compose does not publish; h3 is
  now off (`protocols h1 h2`).
- Caddy's own headers were added next to Rails' (two `X-Frame-Options`, two
  HSTS values); they are now deferred so Caddy's value replaces the app's.

## B. Hardening in place

| Area | What | Where | Evidence |
|---|---|---|---|
| Secrets | Compose `${VAR:?}` for every secret; API/worker refuse to boot on missing/`CHANGE_ME`/short secrets, `*` CORS, invalid S3 config; no code defaults in production | `docker-compose.yml`, `apps/api/config/environments/production.rb`, `config/initializers/storage_config.rb` | A.0 steps 1, 3 |
| Exposure | Only Caddy publishes ports (80/443) and has egress; `proxy` (caddy, api, minio) and `backend` (api, worker, db, redis, minio) are `internal: true`; MinIO console disabled | `docker-compose.yml` | A.0 step 3 |
| Containers | `no-new-privileges` on all long-running services; bounded json-file logs | `docker-compose.yml` | config |
| TLS | TLS 1.2/1.3 only, automatic HTTPS redirect, HSTS 1 year + subdomains (no preload) | `Caddyfile` | A.0 step 3 |
| Headers | nosniff, XFO DENY, no-referrer, COOP, Permissions-Policy, no `Server`; API: `no-store` + `default-src 'none'` CSP; S3: sandbox CSP; API responses not compressed | `Caddyfile` | A.0, A.1 |
| Web client | Strict CSP, immutable hashed assets, SPA shell `no-cache` | `Caddyfile` | A.1 |
| Logs | JSON request line (method, path, status, duration_ms, request_id); no IP/params/query/body; Sidekiq JSON; rescued 4xx not logged with message | `apps/api/config/initializers/logging.rb`, `production.rb` | A.0 step 13 |
| Health | api: `GET /health` via the container healthcheck (`{"ok":true}`); worker: this container's Sidekiq process heartbeating in Redis; db/redis: native checks | `docker-compose.yml` | A.0 step 2 |

Known limits (not changed here): the API image runs as root (no `USER` in
`apps/api/Dockerfile`); Redis has no password (reachable only on `backend`);
MinIO/mc images are unpinned `:latest` (pin digests for production);
`/health` proves the Rails process answers, not that Postgres/Redis/S3 are
reachable; Rack::Attack uses a per-process store (`rack_attack.rb`, M2).

## 0. Architecture

| Role | Docker Compose (`infra/docker/`) | Managed cloud (`infra/cloud/`, not run) |
|---|---|---|
| TLS / reverse proxy + web client | Caddy 2 (Let's Encrypt or local CA), serves `apps/web/dist` | Managed TLS / CDN; must replicate the Caddy headers + CSP |
| API | Rails 7.2 / Puma (`apps/api`) | Same image |
| Worker | Same image, `bundle exec sidekiq` | Second process |
| Database | Postgres 16 | Managed Postgres 16 with PITR |
| Queue | Redis 7 | Managed Redis |
| Object storage | MinIO (public via `s3.<site>`) | R2 / S3 |

The server stores ciphertext + metadata only. Backups still contain account
metadata (emails, passkey public keys, session IPs/user agents, timestamps,
sizes): protect them.

## 1. Prerequisites

- Docker + Compose v2; Node >= 20 + `npm ci` (to build the web client).
- A domain and `s3.<domain>` pointing at the host, TCP 80/443 reachable — PENDING (human).
- 2 GB RAM / 10 GB disk is an assumption, not a measurement.
- Lockfiles are committed (`package-lock.json`, `apps/api/Gemfile.lock`).

## 2. Install (self-host)

```bash
cd infra/docker
cp .env.example .env            # replace every CHANGE_ME (openssl rand -hex 32 / -hex 64)
# SITE_ADDRESS=<your domain>, S3_PUBLIC_ENDPOINT=https://s3.<your domain>,
# WEBAUTHN_RP_ID=<your domain>, WEBAUTHN_ORIGIN=https://<your domain>, CORS_ORIGINS=https://<your domain>
git status --porcelain -- .env  # must print nothing (.env is gitignored)
(cd ../.. && npm ci && npm --workspace apps/web run build)   # web client for Caddy
docker compose up --build -d
docker compose exec api bundle exec rake db:migrate
docker compose ps               # api + worker healthy
curl -fsS https://<your-domain>/health   # {"ok":true}
```

If a secret is missing or still `CHANGE_ME`, `api`/`worker` exit at boot and
`docker compose logs api` names the variable.

## 3. Operate

- **Logs:** `docker compose logs -f api worker` — JSON lines; join a 5xx
  exception to its request by `request_id` (exception lines are tagged with it).
- **Health:** `docker compose ps` (api + worker `healthy`);
  `curl -fsS https://<domain>/health`.
- **Secrets rotation:** edit `.env`, `docker compose up -d --force-recreate api worker`
  (and `minio` for S3 keys), revoke the old value. No automated rotation.
- **Verify a change:** `infra/docker/verify-restore.sh` and
  `infra/docker/verify-web-csp.sh` (both self-contained, throwaway stacks).

## 4. Cloud deployment (not run)

Same env names; see `infra/cloud/README.md`. Before any cutover: a real
presigned upload against R2/S3 (path-style is hardcoded), egress for api/worker
to the managed services, the Caddy headers/CSP replicated at the edge, and a
restore test. All PENDING.

## 5. Secrets management

- Secrets only in `.env` (self-host) or the host's secret store; never in the
  repo or CI logs. `.env.example` holds placeholders only.
- Keep an offline copy of `SECRET_KEY_BASE` and the S3 keys, separate from the
  server and from backups.

## 6. Backup [RUN, A.0]

```bash
cd infra/docker
ENV_FILE=./.env PROJECT=docker ./backup.sh ./backups/$(date -u +%F)   # pg_dump -Fc + mc mirror + sha256 manifest
```

The backup holds ciphertext and account metadata and is NOT encrypted by the
script: encrypt it before it leaves the host with a key kept off the server,
e.g. `tar -C backups -c <dir> | age -r <recipient> > backup.tar.age` (not run).
There is **no rotation**: deleted accounts survive in every older backup
until it is removed. Rotation period and off-host storage — PENDING (human).

## 7. Restore [RUN, A.0]

```bash
cd infra/docker
docker compose stop api worker
ENV_FILE=./.env PROJECT=docker ./restore.sh --yes ./backups/<dir>   # verifies manifest, pg_restore --clean, mc mirror
docker compose up -d && docker compose exec api bundle exec rake db:migrate:status
```

DESTRUCTIVE for the target database. After restoring an older backup,
re-delete every account deleted since that backup was taken (there is no
automatic deletion journal — `docs/privacy.md` §5).

## 8. Upgrade / rollback (not run)

```bash
git pull && (cd ../.. && npm ci && npm --workspace apps/web run build)
docker compose up --build -d && docker compose exec api bundle exec rake db:migrate
```

Take a backup first. Migrations have not been reviewed for reversibility;
there is no release tagging. Rollback = previous commit + restore.

## 9. Validation run log

| Date (UTC) | What | Commit | Command | Result |
|---|---|---|---|---|
| 17 Nov 2026 16:50 | Scenario L (A.0) | `0ae3151` | `infra/docker/verify-restore.sh` | PASS, exit 0, 1m43s |
| 17 Nov 2026 16:50 | Web build under CSP (A.1) | `0ae3151` | `infra/docker/verify-web-csp.sh` | PASS, exit 0, 0 CSP violations |
| 17 Nov 2026 | Media e2e on hardened stack | `0ae3151` | `E2E_PROJECT=a16-media E2E_HTTPS_PORT=19546 E2E_HTTP_PORT=19583 tests/media-e2e/run.sh` | PASS, 9/9 (presigned public URLs, 10 MiB round trip as ciphertext, wrong key + 5 tamper cases rejected, API validation) |
| 17 Nov 2026 | Compose smoke on hardened stack | `0ae3151` | `SMOKE_PROJECT=a16-smoke SMOKE_HTTPS_PORT=19547 SMOKE_HTTP_PORT=19584 ./smoke.sh` | PASS, exit 0 (WebAuthn registration, CORS preflight, presigned PUT/GET via `s3.<site>`, forged signature 403, step-up + DELETE account 204, object 404 after deletion, bucket empty, 0 user rows) |
| 17 Nov 2026 | smoke + backup proof (historical) | `feat/deploy-e2e` | `./smoke.sh`, `./backup-restore-proof.sh` | PASS |
| — | Real domain, Let's Encrypt, real DNS for `s3.<domain>` | — | — | NOT RUN (PENDING) |
| — | Cloud / R2 presigned upload | — | — | NOT RUN (PENDING) |
| — | Upgrade + rollback | — | — | NOT RUN |
| — | Off-host encrypted backup + restore on another host | — | — | NOT RUN (PENDING) |

## 10. Known deployment risks (open)

- Account-deletion gaps and missing retention scheduling (`docs/privacy.md` §5, §7).
- API container runs as root; images not digest-pinned; Redis without auth.
- Rate limiting is per process (no shared store).
- No load/sizing data; no RTO/RPO; no monitoring/alerting beyond healthchecks.
- No external security audit.

## 11. Human-controlled steps — all PENDING

| Step | Owner | Status |
|---|---|---|
| Choose hosting (VPS or managed), size it, set up OS patching + firewall | human | PENDING |
| Register the domain; DNS A/AAAA for `<domain>` and `s3.<domain>` | human | PENDING |
| Public TLS (Caddy + Let's Encrypt on the real domain; decide on HSTS preload) | human | PENDING |
| Production secrets generated and stored offline (`.env`, `SECRET_KEY_BASE`, S3 keys) | human | PENDING |
| SMTP / transactional email (none is integrated in the code today) | human | PENDING |
| Backup schedule, rotation period, encryption key (age/gpg) custody, off-host copy, restore drill on another host | human | PENDING |
| Retention periods (backups, sessions, audit events) + job scheduling decision | human | PENDING |
| Monitoring / alerting / on-call | human | PENDING |
| Apple Developer + Google Play accounts, signing keys, store listings (`docs/store-prep.md`) | human | PENDING |
| Privacy policy legal review and publication (`docs/privacy.md`) | human + lawyer | PENDING |
| External security audit | human | PENDING |
