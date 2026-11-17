# Self-host my-secrect

One backend, Docker Compose: Caddy (TLS) + Rails API + Sidekiq worker +
Postgres 16 + Redis + MinIO (S3-compatible). The server stores ciphertext
only — a stolen server backup still does not reveal vault content (without
the user's keys), but DO protect the backup anyway: it contains metadata.

## 1. Prerequisites
- Docker + Docker Compose v2, a domain pointing at the host (for TLS).
- 2 GB RAM minimum, 10 GB disk to start.

## 2. Install
```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect/infra/docker
cp .env.example .env
# Edit .env: POSTGRES_PASSWORD, S3_ACCESS_KEY/SECRET, RAILS_MASTER_KEY (openssl rand -hex 32)
# Edit Caddyfile: replace vault.example.com with your domain.
docker compose up --build -d
docker compose exec api bundle exec rails db:migrate
curl -fsS https://vault.example.com/health   # {"ok":true}
```

## 3. First use
Create the account from the desktop app (passkey registration), then create
a vault with a master passphrase. The passphrase + recovery key are NEVER
sent to the server — if you lose them, the server cannot help you.

## 4. Backup (encrypted backup)
The vault data on the server is already ciphertext, but back up BOTH:
```bash
# Postgres (metadata + ciphertext + sync history)
docker compose exec db pg_dump -U vault vault_production | gzip > vault-$(date +%F).sql.gz
# MinIO blobs (encrypted file chunks) — back up the named volume.
# NOTE (Phase G fix): the old instruction `docker compose exec minio mc mirror`
# was wrong — the minio/minio image does not ship the `mc` client.
# Use the volume copy below, or run mc as a separate container:
#   docker run --rm -v vault_minio:/data -v "$(pwd)/backup:/backup" alpine \
#     sh -c 'cp -a /data/. /backup/minio/'
docker run --rm -v vault_minio:/data -v "$(pwd)/backup:/backup" alpine sh -c 'cp -a /data/. /backup/minio/'
# Keep backups off-site, encrypted at rest, and test restores.
```
Desktop clients also keep a full encrypted local copy — that is the real
long-term backup. Export an encrypted vault export from the desktop app
regularly (packages/import-export, format v1).

## 5. Restore
> ⚠️ `docker compose down -v` DELETES all named volumes (Postgres +
> MinIO + Caddy data). Run it ONLY after you have a verified backup
> (step 4) and have confirmed the backup files are readable. There is
> no undo. The restore below has never been tested — see
> `docs/deployment.md` for the validation checklist.
```bash
docker compose down -v
# restore the Postgres dump into a fresh db, restore the MinIO volume,
# then: docker compose up -d && docker compose exec api bundle exec rails db:migrate
# Clients re-sync from the restored sequence; conflicts are resolved client-side.
```

## 6. Upgrade
```bash
git pull
docker compose up --build -d
docker compose exec api bundle exec rails db:migrate
```

## 7. Security checklist
- [ ] .env never committed, strong random secrets
- [ ] Only 80/443 exposed; MinIO console (9001) not public
- [ ] TLS via Caddy (Let's Encrypt) — no plain-HTTP API in production
- [ ] Backups tested (restore at least once)
- [ ] Recovery key stored offline by the user
