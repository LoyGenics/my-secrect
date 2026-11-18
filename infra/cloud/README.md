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
  (S3 API domain, never a public custom domain); AWS S3: omit both and set `S3_USE_AWS_ENDPOINT=true`.
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — token scoped to that bucket only.
  For R2 set `S3_REGION=auto`; see `r2.env.example`.
- `SECRET_KEY_BASE` (>= 64 chars; there is no credentials file, `RAILS_MASTER_KEY` does nothing),
  `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — must match the real domain.
- `CORS_ORIGINS` — exact web/desktop origins, never `*` (the API refuses to boot with `*`).
- The web CSP `connect-src` must name the storage origin (`S3_PUBLIC_ENDPOINT`).
- api/worker need outbound access to the managed Postgres/Redis/storage
  (the compose file keeps them on internal networks because MinIO is local).

## R2 notes
- My Secret uses `my-secret-sandbox` for local development and
  `my-secret-production` for the hosted API. Give each Rails environment
  its own Object Read & Write token, scoped to its one bucket.
- To run Rails with the sandbox settings, load the ignored `.env.r2-sandbox`
  in `apps/api` before starting the server. Keep the file readable only by
  its owner (`chmod 600`).
  ```sh
  cd apps/api
  set -a
  . ./.env.r2-sandbox
  set +a
  bundle exec rails server -p 3000
  ```
- The local web and desktop origins are `http://localhost:5174` and
  `http://localhost:1420`. The hosted web origin is `https://msecret.app`.
  Configure each bucket for its corresponding origins only.
- The current Coolify Compose uses MinIO for the API and worker. Switching
  requires updating both services' S3 settings, permitting the worker to
  reach R2, and updating the web proxy's storage origin for CSP. Check for
  existing MinIO objects before switching a live environment: copy existing
  ciphertext to R2 under the same object keys before pointing Rails at it.
  The production token is stored in Coolify as runtime variables
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Map them to Rails'
  `S3_ACCESS_KEY` and `S3_SECRET_KEY` for both services at cutover.
- Keep the bucket private: disable r2.dev and public custom-domain access.
  The API grants access through authenticated, short-lived presigned URLs.
- Apply `r2-cors.example.json` after replacing the example origin with the
  exact web app origin (and any desktop origins used by your deployment).
  Bucket CORS is separate from API `CORS_ORIGINS`; neither grants bucket access.
- R2 presigned URLs only work on its S3 API domain, not custom domains.
  Add that exact HTTPS origin to the deployed web CSP `connect-src`.
  Official references: [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
  [bucket regions](https://developers.cloudflare.com/r2/api/s3/api/#bucket-region),
  [CORS](https://developers.cloudflare.com/r2/buckets/cors/).
- R2 is S3-compatible: the same `aws-sdk-s3` presigned-URL code works.
  Presigned URLs are 5 minutes — confirmed in code
  (`Blobs::StorageProvider::PRESIGN_TTL = 300`).
- The provider uses path-style URLs. The offline provider spec verifies R2
  host, bucket path, `auto` signing region and 300-second expiry; Cloudflare's
  presigned URL documentation also shows path-style examples. An upload
  against a real R2 bucket is still required before a cloud cutover.
- R2 does not implement the S3 bucket versioning API (see the compatibility
  reference above). On AWS S3 with bucket versioning enabled, an account
  deletion only adds delete markers;
  the ciphertext stays as noncurrent versions until a lifecycle rule expires
  them. Either keep versioning off, or add "expire noncurrent versions after N
  days" and publish N in the privacy policy (`docs/privacy.md` §5) — PENDING.
  Also: delete incomplete multipart uploads after 7 days.
- Presigned URLs are 5 minutes; the client uploads ciphertext directly.

## Client-side encryption boundary
- Web/desktop file uploads use `apps/desktop/src/utils/media.ts` and
  `packages/storage/src/upload.ts`: random 32-byte File Key per file,
  authenticated XChaCha20-Poly1305 chunks, then direct binary PUT to storage.
  This is the existing v1 format; switching to AES-GCM requires a separately
  versioned format and migration, and is unnecessary for R2 storage.
- The File Key is wrapped with the client-held Vault Key. File names, MIME
  types, plaintext hashes, chunk nonces and wrapped File Key stay inside a
  Vault-Key-encrypted manifest stored opaquely by the API. Thumbnails are
  encrypted on the client as separate blobs with independent File Keys.
- File API requests contain opaque ids, ciphertext sizes, encrypted manifest and
  ciphertext hashes only. PUT requests use `application/octet-stream`, signed
  into the URL. No plaintext file metadata, raw decryption keys, or SSE-C
  headers are sent. R2's automatic at-rest encryption is an additional layer,
  not the source of end-to-end confidentiality.
- Reads decrypt locally and reject wrong keys, altered chunks and manifest
  substitution. The bucket operator still sees object ids, sizes, counts and
  access timing, and can delete or withhold ciphertext.
- Mobile Files currently uses the same encrypted-chunk format in the local
  filesystem (`apps/mobile/src/storage/localFiles.ts`); cloud file upload and
  cross-device file sync are not wired into that screen. Temporary plaintext
  previews exist in the device cache while viewing and are cleared on lock.
- Vault recovery depends on client-held passphrase/recovery material. A
  compromised client or maliciously replaced web app can read unlocked
  content; owning only the bucket or API database does not provide the keys.

Verification (no real R2 credentials or network required):
```sh
npx tsx --test packages/storage/tests/upload.real.test.mts
cd apps/api && bundle exec rspec spec/domains/storage_provider_spec.rb spec/requests/api/v1/blobs_spec.rb
```
The first runs real libsodium against an in-memory network edge; the Rails
specs exercise signing and authorization with stubbed object storage. These
checks do not prove a deployed R2 bucket, CORS policy or CSP is configured.

## Backups
- Managed Postgres: enable PITR + daily snapshots; test a restore.
- R2/S3: maintain an independent ciphertext backup if the data matters; see the
  versioning note above for S3 (deleted data can persist in backup copies until expired). Desktop clients keep a full encrypted local copy — the
  strongest backup is still the user's own encrypted export + local vault.

## What cloud hosting does NOT change
- The server still never sees plaintext or decryption keys.
- Passkey verification, session TTL, rate limits and revision checks apply
  identically. A managed host is still an untrusted sync server by design.
