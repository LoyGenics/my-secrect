# Self-host my-secrect

One backend, Docker Compose: Caddy (TLS + web client) + Rails API + Sidekiq
worker + Postgres 16 + Redis + MinIO (S3-compatible). The server stores
ciphertext only, but a server backup still contains account metadata
(emails, passkey public keys, session IPs/user agents): protect it.

Validated end to end on a local stack only (`infra/docker/VALIDATION.md`).
A real domain, public TLS, hosting and backups off the host are yours to set
up — see the PENDING list in `docs/deployment.md` §11.

## 1. Prerequisites
- Docker + Compose v2, Node >= 20 (to build the web client).
- A domain AND `s3.<domain>` pointing at the host; TCP 80/443 open.
- An SMTP account (submission port with STARTTLS, or implicit TLS) to send
  sign-up codes. The API will not start without it.

## 2. Install
```bash
cd infra/docker
cp .env.example .env     # replace every CHANGE_ME: openssl rand -hex 32 (SECRET_KEY_BASE: -hex 64)
# set SITE_ADDRESS, S3_PUBLIC_ENDPOINT=https://s3.<domain>, WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN, CORS_ORIGINS,
# and SMTP_ADDRESS, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM
(cd ../.. && npm ci && npm --workspace apps/web run build)
docker compose up --build -d
docker compose exec api bundle exec rake db:migrate
docker compose ps                         # api + worker healthy
curl -fsS https://<domain>/health         # {"ok":true}
```
The api/worker exit at boot (and `docker compose logs api` says which
variable) if a secret is missing, still `CHANGE_ME`, or too short.

## 3. First use
Open `https://<domain>/` (web client) or point the desktop app at
`https://<domain>/api`. Create the account with a passkey, then the vault with
a master passphrase. The passphrase and recovery key never reach the server —
if both are lost, nobody can recover the vault.

## 4. Backup
```bash
cd infra/docker
ENV_FILE=./.env PROJECT=docker ./backup.sh ./backups/$(date -u +%F)
```
Encrypt it before it leaves the host (e.g. `age`), keep the key off the
server, and delete old backups on a schedule: a deleted account stays in every
backup until that backup is removed.

## 5. Restore
Follow `docs/deployment.md` §7: export the account-deletion tombstones
BEFORE restoring, restore, then import + reapply them BEFORE serving —
otherwise accounts deleted after the backup come back.
```bash
docker compose exec -T api bundle exec rake accounts:tombstones:export 2>/dev/null | grep '^{"user_id_digest"' > tombstones.jsonl
docker compose stop api worker
ENV_FILE=./.env PROJECT=docker ./restore.sh --yes ./backups/<dir>   # DESTRUCTIVE for the current DB
docker compose run --rm --no-deps -T -v "$PWD/tombstones.jsonl:/tmp/tombstones.jsonl:ro" api \
  bundle exec rake "accounts:tombstones:import[/tmp/tombstones.jsonl]" accounts:tombstones:reapply
docker compose up -d
```

## 6. Upgrade
```bash
git pull && (cd ../.. && npm ci && npm --workspace apps/web run build)
docker compose up --build -d && docker compose exec api bundle exec rake db:migrate
```

## 7. Security checklist
- [ ] `.env` never committed; strong random secrets (the API enforces no placeholders)
- [ ] Only 80/443 reachable (compose publishes nothing else; check your host firewall too)
- [ ] Real certificate from Let's Encrypt (not the local CA)
- [ ] Backups encrypted, off-host, rotated, and a restore tested
- [ ] Users told to store their recovery key offline
