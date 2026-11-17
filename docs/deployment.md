# Deployment — MY SECRET Personal Digital Vault

> **VALIDATION CAVEAT — READ FIRST**
>
> **Nothing in this document has ever been validated by running it.** No
> `docker compose up`, no migration, no health check, no TLS issuance,
> no backup or restore has ever executed for this repo — on the Mac, in
> CI, or anywhere else. Every command below was derived by READING
> `infra/docker/docker-compose.yml`, `infra/docker/Caddyfile`,
> `apps/api/Dockerfile`, `apps/api/config/routes.rb`, and the infra
> READMEs (Phase G, 17 Nov 2026). Treat this as a checklist to WORK
> THROUGH, not a record of a working deployment. Check each box only
> after you have observed the expected output yourself, and record the
> date + output in the run log (§9).
>
> Until §9 is filled in with observed results, the release gate for
> deployment is FAIL (`docs/release-readiness.md`, gate 9).

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

- [ ] **Close the extra ports.** Compose publishes `3000:3000` (api)
      and `9000:9000`/`9001:9001` (MinIO). Remove those `ports:` entries
      (Caddy reaches the api internally) or bind them to localhost
      (`127.0.0.1:9001:9001`). Verify with `ss -tlnp` / `nmap` after `up`.
- [ ] **Set a real domain in the Caddyfile.** Replace `vault.example.com`
      with your domain in `infra/docker/Caddyfile`. Caddy only obtains a
      Let's Encrypt certificate when the domain points at the host.
- [ ] **Add a CSP.** Neither the Caddyfile nor the web client sets a
      `Content-Security-Policy` (Phase A finding, still open). This needs
      app-side work — do not ship the web client publicly without it.
- [ ] **Remove weak S3 defaults from code.** `Blobs::StorageProvider`
      defaults to `S3_ACCESS_KEY='minio'` / `S3_SECRET_KEY='minio123'`
      when env is empty. Missing env vars currently fail late; add
      fail-fast env validation (or required-var `${VAR:?}` syntax in
      compose) and delete the defaults.
- [ ] **Caddy warm-up:** Caddy `depends_on: [api]` has no health
      condition, so expect 502s for the first seconds after `up`, or add
      `depends_on: api: { condition: service_healthy }`.
- [ ] **Worker env:** the worker service gets no S3 env. Confirm whether
      Sidekiq jobs need S3 (orphan-blob cleanup, quota, retention) and add
      the vars if so.

## 3. Docker self-host — install

Run from `infra/docker/`.

```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect/infra/docker
cp .env.example .env
# Edit .env with REAL secrets (placeholders will not work):
#   POSTGRES_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY, RAILS_MASTER_KEY
#   Generate each with: openssl rand -hex 32
#   WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN must match your real domain.
#   CORS_ORIGINS: exact origins only, never `*`.
# Edit Caddyfile: replace vault.example.com with your domain.

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
docker compose exec api bundle exec rails db:prepare
# Or explicitly:
docker compose exec api bundle exec rails db:migrate
docker compose exec api bundle exec rails db:migrate:status   # all "up"
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
- [ ] `RAILS_MASTER_KEY`, `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — must
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
- `RAILS_MASTER_KEY` (`openssl rand -hex 32`) is required for Rails to
  boot in production. Store a copy offline, separate from the server.
- Rotate a leaked secret by: updating `.env` / the secret store,
  `docker compose up -d --force-recreate api worker`, and revoking the
  old value at the provider. There is no automated rotation.
- Never print secrets in logs, CI output, or support messages. CI uses
  only `ci-only-not-a-secret` placeholder values (see
  `.github/workflows/ci.yml`).

## 6. Backup

The server stores ciphertext, but back up BOTH halves — Postgres
(metadata + ciphertext + sync history) and MinIO/R2 blobs. Desktop
clients keep a full encrypted local copy, and the user should also keep
an encrypted vault export (`packages/import-export`, format v1).

```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect/infra/docker
# Postgres (metadata + ciphertext + sync history)
docker compose exec db pg_dump -U vault vault_production | gzip > vault-$(date +%F).sql.gz
# MinIO blobs (encrypted file chunks) — copy the named volume.
# (The old `docker compose exec minio mc mirror` instruction was wrong:
#  the minio image ships no `mc` client.)
docker run --rm -v vault_minio:/data -v "$(pwd)/backup:/backup" alpine sh -c 'cp -a /data/. /backup/minio/'
# Verify the backup is not empty and is readable:
ls -lh vault-*.sql.gz backup/minio/
gzip -t vault-$(date +%F).sql.gz && echo "dump OK"
# Keep backups off-site, encrypted at rest. Test restores (§7).
```

Cloud: enable managed Postgres PITR + daily snapshots; R2/S3 versioning
on; replicate the bucket to a second region if the data matters.

## 7. Restore (disaster recovery)

> ⚠️ The restore below has NEVER been tested. Do not assume it works.
> The first restore test must be done on a THROWAWAY host, never on the
> live server, and `down -v` deletes all data — only run it after a
> verified backup exists.

```bash
# 1. Stop and wipe the local stack (DESTRUCTIVE — see warning above).
docker compose down -v
# 2. Restore the Postgres dump into a fresh db.
docker compose up -d db
#    (wait for healthy) then:
#    gunzip -c vault-<date>.sql.gz | docker compose exec -T db psql -U vault -d vault_production
# 3. Restore the MinIO volume from backup/minio/ into vault_minio.
# 4. Bring the stack up and migrate:
docker compose up -d
docker compose exec api bundle exec rails db:migrate
curl -fsS https://<your-domain>/health   # {"ok":true}
# 5. Clients re-sync from the restored sequence; conflicts resolve client-side (keep-both).
# 6. Verify: log in from a second device, confirm items decrypt, upload a
#    new file and download it on the first device.
```

Disaster-recovery targets (to be set by the operator — none are set or
tested today): RTO ___, RPO ___. Until a restore test passes, assume
RTO/RPO are unknown.

## 8. Rollback / upgrade

```bash
git pull
docker compose up --build -d
docker compose exec api bundle exec rails db:migrate
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
| — | §3 `up --build` | — | — | NOT RUN |
| — | §3.1 migrations | — | — | NOT RUN |
| — | §3.2 MinIO bucket + presigned round-trip | — | — | NOT RUN |
| — | §3.3 TLS + headers via Caddy | — | — | NOT RUN |
| — | §3.4 worker picks up jobs | — | — | NOT RUN |
| — | §3.5 health checks | — | — | NOT RUN |
| — | §6 backup (dump + volume) | — | — | NOT RUN |
| — | §7 restore on throwaway host | — | — | NOT RUN |
| — | §8 upgrade + rollback | — | — | NOT RUN |
| — | §4 R2 presigned upload | — | — | NOT RUN |

## 10. Known deployment risks (unresolved)

- Compose publishes api/MinIO ports publicly (§2) — fix before exposure.
- No CSP anywhere (web + Caddy).
- No lockfiles → unreproducible builds.
- Weak S3 defaults in code (`minio` / `minio123`).
- `Sync::Pull` omits ciphertext (Phase A, gate 5) — even a perfectly
  deployed server cannot sync today; deployment validation cannot pass
  end-to-end until the sync bug is fixed in app code.
- Passkey verification unwired (gate 1) — account auth is not production-safe.
- No external audit, no backup/restore test, no rollback test.
- Resource numbers (2 GB RAM / 10 GB disk) are assertions, not measurements.
