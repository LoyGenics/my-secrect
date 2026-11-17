# Managed cloud deployment

Same Rails API, managed services instead of Compose. The code does not
change — only the backing services do.

## Mapping
| Compose service | Managed equivalent |
|---|---|
| api (Puma) | Fly.io / Render / Heroku dyno, or a VPS with systemd |
| worker (Sidekiq) | Same host, second process, or a worker dyno |
| db Postgres 16 | Neon / Supabase / RDS Postgres 16, TLS, PITR backups |
| redis | Upstash / Redis Cloud / ElastiCache |
| minio | Cloudflare R2 (S3-compatible, no egress fees) or AWS S3 |
| caddy | Cloudflare Tunnel / managed TLS + WAF in front of the API; must serve the web build with the SAME headers + CSP as `infra/docker/Caddyfile` |

## Environment (same names as .env.example)
- `DATABASE_URL` — managed Postgres URL (TLS, `sslmode=require`).
- `REDIS_URL` — managed Redis URL.
- `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT` — R2: both `https://<account>.r2.cloudflarestorage.com`
  (or a custom domain); AWS S3: omit both and set `S3_USE_AWS_ENDPOINT=true`.
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — token scoped to that bucket only.
- `SECRET_KEY_BASE` (>= 64 chars; there is no credentials file, `RAILS_MASTER_KEY` does nothing),
  `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — must match the real domain.
- `CORS_ORIGINS` — exact web/desktop origins, never `*` (the API refuses to boot with `*`).
- The web CSP `connect-src` must name the storage origin (`S3_PUBLIC_ENDPOINT`).
- api/worker need outbound access to the managed Postgres/Redis/storage
  (the compose file keeps them on internal networks because MinIO is local).

## R2 notes
- R2 is S3-compatible: the same `aws-sdk-s3` presigned-URL code works.
  Presigned URLs are 5 minutes — confirmed in code
  (`Blobs::StorageProvider::PRESIGN_TTL = 300`).
- ⚠️ CORRECTED (Phase G): the old note said to set `force_path_style: true`
  "only for MinIO". The code hardcodes `force_path_style: true`
  unconditionally (`apps/api/app/domains/blobs/storage_provider.rb`),
  so there is no per-provider switch today. Whether R2 accepts
  path-style URLs from this client is UNVERIFIED — test a presigned
  upload against a real R2 bucket before any cloud cutover; if R2
  rejects path-style, the code must be changed first.
- Bucket versioning: if enabled, an account deletion only adds delete markers;
  the ciphertext stays as noncurrent versions until a lifecycle rule expires
  them. Either keep versioning off, or add "expire noncurrent versions after N
  days" and publish N in the privacy policy (`docs/privacy.md` §5) — PENDING.
  Also: delete incomplete multipart uploads after 7 days.
- Presigned URLs are 5 minutes; the client uploads ciphertext directly.

## Backups
- Managed Postgres: enable PITR + daily snapshots; test a restore.
- R2/S3: replicate the bucket if the data matters; see the versioning note
  above (deleted data persists in versions/replicas until expired). Desktop clients keep a full encrypted local copy — the
  strongest backup is still the user's own encrypted export + local vault.

## What cloud hosting does NOT change
- The server still never sees plaintext or decryption keys.
- Passkey verification, session TTL, rate limits and revision checks apply
  identically. A managed host is still an untrusted sync server by design.
