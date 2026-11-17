# infra/docker

- `docker-compose.yml` — Caddy + api + worker + Postgres 16 + Redis + MinIO (+ one-shot `minio-init` bucket creator). Only Caddy publishes ports; egress only for Caddy (ACME) and the api (SMTP for sign-up codes); everything else is on internal networks.
- `docker-compose.test.yml` — TEST-ONLY override for the throwaway stacks: Mailpit as the SMTP server (STARTTLS with a per-run CA from `lib/mail.sh`), its HTTP API on 127.0.0.1 so test clients can read sign-up codes. Never use in production.
- `Caddyfile` — TLS (1.2/1.3), security headers, strict CSP; serves the built web client (`WEB_DIST`, default `../../apps/web/dist`), proxies `/api` + `/health` to the API and `s3.<site>` to MinIO.
- `.env.example` — copy to `.env`, replace every `CHANGE_ME`, never commit it. Compose refuses unset variables; the API refuses to boot on placeholders/weak values.
- `Dockerfile.api` — DEPRECATED stub; live Dockerfile is `apps/api/Dockerfile`.
- `backup.sh` / `restore.sh` — server backup (pg_dump + MinIO mirror + sha256 manifest) and restore.
- `verify-restore.sh` — scenario L end to end (deploy, real client, restart, backup, destroy, restore, decrypt, account deletion, log scan). Throwaway stack `a16-scenl`.
- `verify-web-csp.sh` — the built web client in Chromium under the CSP, 0 violations required. Throwaway stack `a16-csp`.
- `scan-logs.sh` — fails if container logs contain secret material (used by both verify scripts).
- `smoke.sh` — compose smoke (sign-up via email code + device proof, blob round trip, account deletion); `smoke/signup.rb` is the shared Ruby sign-up helper (also used by `tests/media-e2e/register.rb`).
- `backup-restore-proof.sh` — older SQL-seeded proof (base compose only; superseded by `verify-restore.sh`).

Run: build the web client (`npm ci && npm --workspace apps/web run build` at the repo root), then
`docker compose up --build -d` and `docker compose exec api bundle exec rake db:migrate`.

Status and evidence: `VALIDATION.md`, `docs/deployment.md`.
