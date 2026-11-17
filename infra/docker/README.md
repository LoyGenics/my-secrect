# infra/docker

- `docker-compose.yml` — Caddy + api + worker + Postgres 16 + Redis + MinIO (+ one-shot `minio-init` bucket creator).
- `Caddyfile` — TLS reverse proxy; site address from `SITE_ADDRESS`.
- `.env.example` — copy to `.env`, replace every `CHANGE_ME`, never commit it. Compose fails fast if a required variable is unset.
- `Dockerfile.api` — DEPRECATED stub; live Dockerfile is `apps/api/Dockerfile`.
- `smoke.sh` — end-to-end smoke test with a throwaway env (see `docs/deployment.md` §A.1).
- `backup.sh` / `restore.sh` / `backup-restore-proof.sh` — server backup and restore (see `docs/deployment.md` §A.2, §A.5).

Run: `docker compose up --build -d`, then `docker compose exec api bundle exec rake db:migrate`.

Validation status (17 Nov 2026): `smoke.sh` and `backup-restore-proof.sh` were run on one
macOS/Docker Desktop host and passed. Real-domain TLS, cloud/R2 and upgrade/rollback were not run.
Older static findings in `VALIDATION.md` are historical; `docs/deployment.md` §A.3 lists what was fixed.
