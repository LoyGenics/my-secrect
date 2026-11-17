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
| caddy | Cloudflare Tunnel / managed TLS + WAF in front of the API |

## Environment (same names as .env.example)
- `DATABASE_URL` — managed Postgres URL (TLS, `sslmode=require`).
- `REDIS_URL` — managed Redis URL.
- `S3_ENDPOINT` — R2: `https://<account>.r2.cloudflarestorage.com` (or S3 default).
- `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — R2 API token (object Read/Write on that bucket only).
- `RAILS_MASTER_KEY`, `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — must match the real domain.
- `CORS_ORIGINS` — exact web/desktop origins, never `*`.

## R2 notes
- R2 is S3-compatible: the same `aws-sdk-s3` presigned-URL code works;
  set `force_path_style: true` only for MinIO, R2 accepts the default.
  (If R2 rejects path-style, remove that option in Blobs::StorageProvider.)
- Enable R2 bucket versioning + object lock off; lifecycle: delete incomplete
  multipart uploads after 7 days (the cleanup job covers the DB side).
- Presigned URLs are 5 minutes; the client uploads ciphertext directly.

## Backups
- Managed Postgres: enable PITR + daily snapshots; test a restore.
- R2/S3: versioning on; replicate the bucket to a second region if the
  data matters. Desktop clients keep a full encrypted local copy — the
  strongest backup is still the user's own encrypted export + local vault.

## What cloud hosting does NOT change
- The server still never sees plaintext or decryption keys.
- Passkey verification, session TTL, rate limits and revision checks apply
  identically. A managed host is still an untrusted sync server by design.
