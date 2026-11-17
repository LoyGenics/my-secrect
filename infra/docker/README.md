# infra/docker

- `docker-compose.yml` — Caddy + api + worker + Postgres 16 + Redis + MinIO.
- `Caddyfile` — TLS reverse proxy (set your domain).
- `.env.example` — copy to `.env`, fill in secrets, never commit it.
- `Dockerfile.api` — DEPRECATED stub; live Dockerfile is `apps/api/Dockerfile`.

Run: `docker compose up --build -d`, then `docker compose exec api bundle exec rails db:migrate`.
Full steps: see `../self-host/README.md`.

> Validation status (Phase G, 17 Nov 2026): NEVER RUN. Nothing under
> `infra/` has been started, migrated, or health-checked. Static findings
> (exposed api/MinIO ports, no CSP, missing lockfiles, weak S3 defaults,
> Caddy warm-up 502s) are recorded in `VALIDATION.md`; the step-by-step
> validation checklist is `docs/deployment.md`.
