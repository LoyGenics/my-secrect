# infra/docker

- `docker-compose.yml` — Caddy + api + worker + Postgres 16 + Redis + MinIO.
- `Caddyfile` — TLS reverse proxy (set your domain).
- `.env.example` — copy to `.env`, fill in secrets, never commit it.
- `Dockerfile.api` — DEPRECATED stub; live Dockerfile is `apps/api/Dockerfile`.

Run: `docker compose up --build -d`, then `docker compose exec api bundle exec rails db:migrate`.
Full steps: see `../self-host/README.md`.
