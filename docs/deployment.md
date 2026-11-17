# Deployment — MY SECRET Personal Digital Vault

> **VALIDATION STATUS (updated 17 Nov 2026, branch `feat/deploy-e2e`)**
>
> Two scripts under `infra/docker/` were RUN for real on one Mac
> (macOS, Docker Desktop 28 / Compose v2.40, arm64) and passed. The sections
> marked **[RUN]** are backed by those runs (§A). Everything else in this
> document is still a checklist derived by reading files and has NOT been run:
> real-domain TLS/Let's Encrypt, managed cloud / R2, off-host or
> cross-version restores, upgrade/rollback, load/sizing.

## A. Evidence-backed results [RUN]

Environment: macOS arm64, Docker Compose v2.40.0-desktop.1. Images:
`caddy:2-alpine`, `postgres:16-alpine`, `redis:7-alpine`, API image built
from `apps/api/Dockerfile` (ruby 3.3), MinIO `cgr.dev/chainguard/minio:latest`
(RELEASE.2026-11-16) and `cgr.dev/chainguard/minio-client:latest`.

### A.1 `infra/docker/smoke.sh` -> exit code 0

Command: `cd infra/docker && ./smoke.sh`. It generates a throwaway random env
file (nothing from the repo), then ran and passed:

1. compose refuses an empty environment (`${VAR:?}` fail-fast);
2. `up -d --build` of caddy, api, worker, db, redis, minio, minio-init;
3. api container healthcheck turns healthy; `rake db:migrate` (3 migrations);
4. `GET https://localhost:18443/health` through Caddy (internal CA) -> `{"ok":true}`;
   unauthenticated `GET /api/v1/vaults` -> 401;
5. bucket exists (created by the one-shot `minio-init`);
6. `smoke/flow.rb` inside the api container, over HTTPS through Caddy to the real
   API and real MinIO: real WebAuthn registration (software authenticator =
   the `webauthn` gem's `FakeClient`; the server verifies real attestation) ->
   vault create -> blob `upload-session` -> presigned PUT of 1 MiB RANDOM
   bytes (a stand-in for ciphertext; no crypto is exercised or claimed) ->
   `complete` -> `download-session` -> presigned GET -> byte equality
   (sha256) -> passkey step-up -> `DELETE /api/v1/auth/account` (204) -> old
   token 401 -> MinIO HEAD returns 404 (object deleted);
7. independent checks: `mc ls --recursive` shows an empty bucket, 0 smoke users in
   postgres, worker container up with no Sidekiq thread crash in its log;
8. `docker compose down -v` teardown (no containers/volumes left).

Not exercised: a browser/native client, TLS from a public CA, MFA, recovery,
sharing, sync endpoints.

### A.2 `infra/docker/backup-restore-proof.sh` -> exit code 0

Command: `cd infra/docker && ./backup-restore-proof.sh`. Seeds 3 users, 3
vaults, 1 blob + part rows via SQL and a 256 KiB random object in MinIO; runs
`backup.sh`; runs `docker compose down -v` (destroys all volumes) and boots an
empty stack (asserted: no `users` table, object absent); runs `restore.sh --yes`;
then compares. Observed: row-count/md5 fingerprint `3/3/1/1
6d499055e5faaf45bedf444e38b45f96` before and after; object sha256
`0a90b4d8ce24f03c7b9149468bf445714d912f7182b3527eb506b11440721ccb` before and
after. Only that one DB shape and one small object were tested (same host,
same Postgres major version, same MinIO).

### A.3 Real problems found by running, and fixed

- `apps/api/Dockerfile` CMD was `rails server`; the app has no `bin/rails`, so
  the container ran the Rails app generator and never served. Now `puma`.
- `require 'rails/all'` pulled in Active Storage, which aborted production
  boot (`config/storage.yml` missing). `config/application.rb` now requires only
  the frameworks the API uses.
- Sidekiq 7.3.9 crashed its scheduler thread with `connection_pool` 3.0.3; the
  Gemfile now pins `connection_pool ~> 2.4` (lockfile updated: 2.5.5).
- Production ActiveJob had no queue adapter, so the worker would idle; now `:sidekiq`.
- No `credentials.yml.enc` exists, so `RAILS_MASTER_KEY` does nothing;
  Rails needs `SECRET_KEY_BASE` (compose now requires it).
- Docker Hub `minio/minio` and `minio/mc` are no longer pullable (observed:
  "pull access denied"); quay.io timed out from this host. Compose now defaults to
  the Chainguard images and takes `MINIO_IMAGE` / `MC_IMAGE` overrides. Those
  images are unpinned `:latest` and shell-less, so MinIO has no container
  healthcheck (the `minio-init` retry gates the api instead). Pin digests for
  production.
- Weak S3 defaults removed (`StorageProvider` raises `ConfigError` naming the
  missing variable; compose requires all `S3_*`); Caddy waits on the api health;
  the worker has S3 env; the account-deletion storage gap is closed (specs in
  `apps/api/spec`).

### A.4 Known gap (unresolved)

Presigned URLs are signed against `S3_ENDPOINT` (`http://minio:9000`, a
compose-internal name). A real browser/desktop client outside the Docker
network cannot reach that host, so direct-to-MinIO uploads will fail until a
public S3 endpoint (a Caddy site for MinIO, or R2/S3) is configured. The
smoke test performs the PUT/GET from inside the network, so it does not cover
this.

### A.5 Backup/restore usage and encryption at rest

```bash
cd infra/docker
ENV_FILE=./.env PROJECT=docker ./backup.sh ./backups/$(date -u +%F)   # pg_dump -Fc + mc mirror + sha256 manifest
ENV_FILE=./.env PROJECT=docker ./restore.sh --yes ./backups/<dir>     # verifies manifest, pg_restore --clean, mc mirror
```

The backup is ciphertext blobs plus account metadata (emails, credential
ids, session digests). `backup.sh` does NOT encrypt and ships no keys. Encrypt
before the backup leaves the host, with a key kept off the server, for example
`tar -C backups -c <dir> | age -r <recipient> > backup.tar.age` (age/gpg were
not run as part of the proof). Also enable disk/volume encryption on the host.
`backups/` is gitignored.

## 0. Architecture (as designed, not as observed)

One Rails API backend, two ways to host it. The code does not change —
only the backing services do.

| Role | Docker Compose (`infra/docker/`) | Managed cloud (`infra/cloud/`) |
|---|---|---|
| TLS / reverse proxy | Caddy 2-alpine (Let's Encrypt) | Cloudflare Tunnel / managed TLS + WAF |
| API | Rails 7.1 / Puma (`apps/api`) | Fly.io / Render / Heroku dyno, or VPS |
| Worker | Same image, `bundle exec sidekiq` | Second process / worker dyno |
| Database | Postgres 16-alpine | Neon / Supabase / RDS Postgres 16, PITR |
| Queue/cache | Redis 7-alpine | Upstash / Redis Cloud / ElastiCache |
| Object storage | MinIO (S3-compatible) | Cloudflare R2 or AWS S3 |

The server stores ciphertext + metadata only. It never sees plaintext
or decryption keys — by design. A stolen server backup still does not
reveal vault content (without the user's keys), but protect backups
anyway: they contain metadata (item ids, revisions, timestamps, sizes).

## 1. Prerequisites

- [ ] Docker + Docker Compose v2 installed (`docker compose version`).
- [ ] A domain pointing at the host (required for Caddy/Let's Encrypt TLS).
- [ ] 2 GB RAM minimum, 10 GB disk to start. *(Assertion from the
      self-host README, not a measurement — re-check under load.)*
- [ ] Ports 80/443 reachable from the internet; ports 3000/9000/9001
      NOT reachable (see §2 — the compose file currently publishes them).
- [ ] Lockfiles committed: `package-lock.json` and `apps/api/Gemfile.lock`
      (both missing as of Phase G — see `.github/workflows/ci.yml`).
      Without them a build resolves dependencies fresh each time.
- [ ] Git history scanned for secrets (weekly gitleaks job — never run).

## 2. Pre-flight fixes (do these BEFORE the first public run)

These are static findings from `infra/docker/VALIDATION.md`. They are
not optional hardening — the first two contradict the docs as written.

- [x] **Close the extra ports (compose now publishes only Caddy 80/443; `ports:` for api/MinIO are gone).** Compose publishes `3000:3000` (api)
      and `9000:9000`/`9001:9001` (MinIO). Remove those `ports:` entries
      (Caddy reaches the api internally) or bind them to localhost
      (`127.0.0.1:9001:9001`). Verify with `ss -tlnp` / `nmap` after `up`.
- [ ] **Set a real domain in the Caddyfile.** Replace `vault.example.com`
      with your domain in `infra/docker/Caddyfile`. Caddy only obtains a
      Let's Encrypt certificate when the domain points at the host.
- [ ] **Add a CSP.** Neither the Caddyfile nor the web client sets a
      `Content-Security-Policy` (Phase A finding, still open). This needs
      app-side work — do not ship the web client publicly without it.
- [x] **[RUN] Remove weak S3 defaults from code (done, see §A.3).** Original finding: `Blobs::StorageProvider`
      defaults to `S3_ACCESS_KEY='minio'` / `S3_SECRET_KEY='minio123'`
      when env is empty. Missing env vars currently fail late; add
      fail-fast env validation (or required-var `${VAR:?}` syntax in
      compose) and delete the defaults.
- [x] **Caddy warm-up (fixed: Caddy waits for api healthy):** Caddy `depends_on: [api]` has no health
      condition, so expect 502s for the first seconds after `up`, or add
      `depends_on: api: { condition: service_healthy }`.
- [x] **Worker env (fixed: S3 env added):** the worker service gets no S3 env. Confirm whether
      Sidekiq jobs need S3 (orphan-blob cleanup, quota, retention) and add
      the vars if so.

## 3. Docker self-host — install

Run from `infra/docker/`.

```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect/infra/docker
cp .env.example .env
# Edit .env with REAL secrets (placeholders will not work):
#   POSTGRES_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY, SECRET_KEY_BASE, SITE_ADDRESS
#   Generate each with: openssl rand -hex 32
#   WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN must match your real domain.
#   CORS_ORIGINS: exact origins only, never `*`.
# SITE_ADDRESS in .env sets the Caddy domain (no Caddyfile edit needed).

# NEVER commit .env — .gitignore covers .env / .env.* (verified 17 Nov 2026).
# Confirm before proceeding:
git status --porcelain -- infra/docker/.env   # must print nothing

docker compose up --build -d
docker compose ps            # all services up / healthy
docker compose logs -f api   # watch Rails boot; no stack trace, no missing-key error
```

### 3.1 Database init + migrations

```bash
# First boot: create + migrate (db:prepare is idempotent — safe to re-run).
docker compose exec api bundle exec rake db:migrate
# Or explicitly:
docker compose exec api bundle exec rake db:migrate
docker compose exec api bundle exec rake db:migrate:status   # all "up"
# Verify the schema matches the models (users, vaults, items, sync history):
docker compose exec db psql -U vault -d vault_production -c '\dt'
```

Expected: migrations apply with no errors; `db:migrate:status` shows
all migrations `up`. **Never observed — record actual output in §9.**

### 3.2 Storage (MinIO bucket)

```bash
# Confirm MinIO is healthy and reachable from the api container:
docker compose exec api curl -fsS http://minio:9000/minio/health/live
# Confirm the bucket exists (created by the app on first use, or pre-create):
docker compose exec minio ls /data   # or use the MinIO console on :9001 (localhost only)
# Confirm a presigned upload round-trips (5-minute TTL, code: PRESIGN_TTL = 300):
#   1. Create an item / upload a file from the desktop app.
#   2. Confirm the encrypted chunk object appears under the bucket.
#   3. Download it from another device and confirm it decrypts.
```

### 3.3 TLS

```bash
curl -fsS https://<your-domain>/health   # {"ok":true}
curl -sI https://<your-domain>/health | grep -i -E 'strict-transport|x-content-type|x-frame|referrer'
# Expected headers (from Caddyfile): HSTS max-age=31536000, nosniff,
# X-Frame-Options DENY, Referrer-Policy no-referrer.
# Also check: http://<your-domain> redirects to https (Caddy default).
# Also check: certificate is a valid Let's Encrypt cert, not self-signed:
#   echo | openssl s_client -connect <your-domain>:443 -servername <your-domain> 2>/dev/null | openssl x509 -noout -issuer -dates
```

For local-only use, comment the domain block out of the Caddyfile and
use `http://localhost:3000` directly (no TLS on localhost) — never expose
plain HTTP publicly.

### 3.4 Workers (Sidekiq)

```bash
docker compose exec worker bundle exec sidekiq --version   # or: ps inside the container
docker compose logs -f worker   # no crash loop, jobs picked up
# Trigger a job the app actually schedules (orphan-blob cleanup / retention)
# and confirm it completes — which jobs exist is unverified; confirm
# against the job classes in apps/api before relying on this.
```

### 3.5 Health checks

```bash
# API liveness (route exists in apps/api/config/routes.rb):
curl -fsS http://localhost:3000/health          # {"ok":true}
curl -fsS https://<your-domain>/health         # {"ok":true} via Caddy
# Container health (compose + Dockerfile HEALTHCHECK):
docker compose ps                              # db/minio healthy, api/worker up
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q api)
# Dependencies:
docker compose exec db pg_isready -U vault -d vault_production
docker compose exec redis redis-cli ping       # PONG
docker compose exec minio curl -fsS http://localhost:9000/minio/health/live
```

Note: `/health` only proves the Rails process answers. It does NOT prove
the DB, Redis, or MinIO are reachable from the app — check the logs for
connection errors after boot.

## 4. Cloud deployment (managed services)

Same env names as `.env.example`. See `infra/cloud/README.md`.

- [ ] `DATABASE_URL` — managed Postgres, TLS, `sslmode=require`.
- [ ] `REDIS_URL` — managed Redis.
- [ ] `S3_ENDPOINT` — R2: `https://<account>.r2.cloudflarestorage.com`.
- [ ] `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — R2 token scoped to
      that bucket only (Read/Write).
- [ ] `SECRET_KEY_BASE`, `S3_REGION`, `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — must
      match the real domain.
- [ ] `CORS_ORIGINS` — exact origins, never `*`.
- [ ] **R2 path-style check (BLOCKER):** the code hardcodes
      `force_path_style: true`. Confirm a presigned upload works against
      a real R2 bucket before cutover; if R2 rejects path-style, change
      `Blobs::StorageProvider` first (unverified).
- [ ] R2 bucket versioning on; lifecycle: delete incomplete multipart
      uploads after 7 days.
- [ ] Managed Postgres: PITR + daily snapshots; test a restore (§7).

## 5. Secrets management

- Secrets live ONLY in `.env` (self-host) or the host's secret store
  (cloud: Fly.io/Render/Heroku secrets, never in the repo or in CI logs).
- `.env` is gitignored (`.env`, `.env.*`, except `!.env.example`).
  `.env.example` contains placeholders only — verified Phase G.
- `SECRET_KEY_BASE` (`openssl rand -hex 64`) is required for Rails to
  boot in production (no credentials file exists). Store a copy offline, separate from the server.
- Rotate a leaked secret by: updating `.env` / the secret store,
  `docker compose up -d --force-recreate api worker`, and revoking the
  old value at the provider. There is no automated rotation.
- Never print secrets in logs, CI output, or support messages. CI uses
  only `ci-only-not-a-secret` placeholder values (see
  `.github/workflows/ci.yml`).

## 6. Backup [RUN]

Use `infra/docker/backup.sh` (see §A.5; exercised by `backup-restore-proof.sh`,
§A.2). Back up BOTH halves: Postgres and the object bucket. Desktop clients keep
an encrypted local copy; users should also keep an encrypted vault export
(`packages/import-export`). Cloud: managed Postgres PITR + daily snapshots and
bucket versioning (not run here).

## 7. Restore [RUN on one host]

Use `infra/docker/restore.sh --yes <dir>` (§A.5). DESTRUCTIVE: `pg_restore --clean`
replaces all objects in `vault_production`. Proven only by §A.2 (destroy volumes
-> empty stack -> restore -> identical rows and object bytes). Not tested:
restore on a different host, a different Postgres/MinIO version, large data,
or timing. RTO/RPO remain unmeasured.

## 8. Rollback / upgrade

```bash
git pull
docker compose up --build -d
docker compose exec api bundle exec rake db:migrate
curl -fsS https://<your-domain>/health
# Rollback: check out the previous release tag/commit, rebuild, migrate.
# NOTE: Rails migrations in this repo have not been reviewed for
# reversibility — confirm `db:migrate:status` and that each migration is
# reversible before relying on rollback. There is no release tagging
# process yet (see docs/release-readiness.md).
```

## 9. Deployment validation run log

Fill this in as each step is OBSERVED (date, host, command, output).
Do not tick boxes from memory.

| Date | Step | Host / env | Command | Observed result |
|---|---|---|---|---|
| 17 Nov 2026 | §A.1 smoke (up, migrate, health, blob round trip, delete) | macOS arm64, Docker 28 | `./smoke.sh` | PASS, exit 0 |
| 17 Nov 2026 | §A.2 backup/destroy/restore proof | same | `./backup-restore-proof.sh` | PASS, exit 0 |
| — | §3 `up --build` (real domain) | — | — | NOT RUN |
| — | §3.1 migrations | — | — | NOT RUN |
| — | §3.2 MinIO bucket + presigned round-trip | — | — | NOT RUN |
| — | §3.3 TLS + headers via Caddy | — | — | NOT RUN |
| — | §3.4 worker picks up jobs | — | — | NOT RUN |
| — | §3.5 health checks | — | — | NOT RUN |
| — | §8 upgrade + rollback | — | — | NOT RUN |
| — | §4 R2 presigned upload | — | — | NOT RUN |

## 10. Known deployment risks (unresolved)

- Compose publishes api/MinIO ports publicly (§2) — fix before exposure.
- No CSP anywhere (web + Caddy).
- No lockfiles → unreproducible builds.
- Presigned URL host is the compose-internal MinIO name (§A.4).
- `Sync::Pull` omits ciphertext (Phase A, gate 5) — even a perfectly
  deployed server cannot sync today; deployment validation cannot pass
  end-to-end until the sync bug is fixed in app code.
- Passkey verification unwired (gate 1) — account auth is not production-safe.
- No external audit, no backup/restore test, no rollback test.
- Resource numbers (2 GB RAM / 10 GB disk) are assertions, not measurements.
