# infra/docker — validation notes (Phase G, 17 Nov 2026)

> **Scope of this file:** static validation only. The files under
> `infra/docker/` were READ and cross-checked against `apps/api/` and the
> infra READMEs. **Nothing was run**: no `docker compose up`, no migration,
> no health check, no TLS issuance, no backup/restore. Every item below is
> marked by what the code says, not by what was observed. The deployment
> validation checklist (with exact commands) lives in
> `docs/deployment.md` — it is a TODO list until someone runs it.

## What was checked

| File | What the code says |
|---|---|
| `docker-compose.yml` | Caddy 2-alpine + api + worker + Postgres 16-alpine + Redis 7-alpine + MinIO latest. Build context `../../apps/api`, Dockerfile there. |
| `Caddyfile` | `vault.example.com` reverse-proxies `api:3000`; sets HSTS, nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| `Dockerfile.api` | Deprecated stub only; live Dockerfile is `apps/api/Dockerfile`. Correct as a pointer. |
| `apps/api/Dockerfile` | `ruby:3.3-slim`, `bundle install --without development test`, `HEALTHCHECK curl http://localhost:3000/health`, `rails server -b 0.0.0.0 -p 3000`. |
| `apps/api/config/routes.rb` | `GET /health` returns `{"ok":true}` — matches the curl in the self-host README. |
| `.env.example` | **Created in Phase G.** It did not exist before, although both READMEs told the user to `cp .env.example .env`. Placeholders only. |

## Findings (static only — none verified by running)

### 1. Ports exposed wider than the docs promise — UNVALIDATED, needs a decision
- Compose publishes `3000:3000` (api) and `9000:9000` + `9001:9001`
  (MinIO API + console) on the host. The self-host README checklist says
  "Only 80/443 exposed; MinIO console (9001) not public" — as written,
  the compose file contradicts that checklist. In production the api and
  MinIO ports should be removed from `ports:` (Caddy reaches the api over
  the internal network) or bound to localhost (`127.0.0.1:9001:9001`).
  **Not changed in Phase G** (compose edits are out of the validation-only
  scope for this pass); recorded here so the deployer fixes it before
  first public run. See `docs/deployment.md` §2.

### 2. Caddy has no CSP and no Permissions-Policy — CONFIRMED by reading
- The Caddyfile sets four headers but no `Content-Security-Policy`.
  The web client also ships no CSP (`apps/web/vite.config.ts`,
  `index.html` — no meta CSP, no headers). Phase A already recorded
  "No CSP/headers on web". This is a hardening gap, not a typo: fixing
  it requires app-side work (CSP in the web build / Caddy), which is
  outside Phase G scope. Recorded as a release blocker in
  `docs/release-readiness.md`.

### 3. `mc mirror` backup command in the self-host README is wrong — FIXED
- The README told the user to run `docker compose exec minio mc mirror`.
  The `minio/minio` image does not ship the `mc` client, so that command
  fails. Fixed in `infra/self-host/README.md` (volume/`docker cp` backup
  + `mc` as an optional separate container). The corrected commands are
  still **unvalidated by running**.

### 4. Cloud README misstates `force_path_style` — FIXED
- It said to set `force_path_style: true` "only for MinIO" and remove it
  for R2. The code (`apps/api/app/domains/blobs/storage_provider.rb`)
  hardcodes `force_path_style: true` unconditionally, and the presigned
  TTL of 300s (5 min) is confirmed in code (`PRESIGN_TTL = 300`). Fixed
  in `infra/cloud/README.md`: R2 compatibility with path-style URLs is
  **unverified** and needs a live test before any cloud cutover.

### 5. No lockfiles — compose builds resolve dependencies fresh — CONFIRMED
- `apps/api/Dockerfile` does `COPY Gemfile Gemfile.lock*` (lockfile
  optional) and there is no `Gemfile.lock` in the repo, and no
  `package-lock.json` at the root. A compose build therefore resolves
  gem versions at build time — two builds on different days can produce
  different images. Generate and commit lockfiles first
  (`bundle lock`, `npm install`); CI enforces their presence
  (`.github/workflows/ci.yml`, `lockfiles` job).

### 6. Missing env vars fail late, not at boot — CONFIRMED by reading
- Compose interpolates `${POSTGRES_PASSWORD}`, `${S3_ACCESS_KEY}`,
  `${S3_SECRET_KEY}`, `${RAILS_MASTER_KEY}` with no defaults: unset vars
  become empty strings. The API code falls back to weak defaults
  (historical: `S3_ACCESS_KEY` → `'minio'`, `S3_SECRET_KEY` → `'minio123'` in
  `storage_provider.rb`) when env is empty, and Rails fails to boot
  without a master key. There is no fail-fast env validation. Add a
  boot-time check (or `? :-` required-var syntax in compose) before
  first deployment. The weak `'minio123'` default is a known finding —
  it is deliberately NOT allowlisted in `.github/gitleaks.toml`.

### 7. Caddy may proxy before Rails is ready — UNVALIDATED
- Caddy `depends_on: [api]` has no health condition, and compose defines
  no healthcheck for the `api` service (the Dockerfile HEALTHCHECK exists
  but compose does not wait on it). Expect 502s for the first seconds
  after `up`. Add `depends_on: api: { condition: service_healthy }` (or
  accept the warm-up 502s) — unvalidated either way.

### 8. Worker environment is incomplete — UNVALIDATED
- The `worker` service gets `DATABASE_URL`, `REDIS_URL` and
  `RAILS_MASTER_KEY` only — no S3 env. Whether Sidekiq jobs need S3
  (orphan-blob cleanup, quota, retention) is unverified from the code
  read; confirm against the job classes before first run.

### 9. Restore procedure destroys data before restoring — CONFIRMED wording risk
- The self-host README's restore step starts with `docker compose down -v`,
  which deletes all named volumes (Postgres + MinIO + Caddy data). That is
  only safe AFTER a verified backup exists. The README now carries that
  warning explicitly. The restore itself has never been tested.

## Not checked (out of scope for a static pass)
- Whether the image actually builds (`docker build` — CI does this, never run).
- Whether migrations run cleanly, Sidekiq picks up jobs, MinIO buckets are created, Caddy obtains a Let's Encrypt certificate, or `GET /health` answers through Caddy.
- Resource sizing (2 GB RAM / 10 GB disk in the README is an assertion, not a measurement).
- Any secret ever committed to git history (first history scan is the weekly gitleaks job in `.github/workflows/security.yml` — never run).
