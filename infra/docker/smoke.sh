#!/usr/bin/env bash
# Compose end-to-end smoke test. Brings the stack up with a THROWAWAY random
# env (no secrets from the repo), migrates, round-trips a blob through real
# MinIO via the real API (real WebAuthn registration with a software
# authenticator), deletes the account, asserts the MinIO object is gone, and
# tears everything down (including volumes).  Usage: ./smoke.sh [--keep]
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=${SMOKE_PROJECT:-vsmoke}
HTTPS_PORT=${SMOKE_HTTPS_PORT:-18443}
HTTP_PORT=${SMOKE_HTTP_PORT:-18080}
KEEP=${1:-}
ENVF=$(mktemp -t vsmoke-env.XXXXXX)
rand() { openssl rand -hex "$1"; }
cat >"$ENVF" <<ENV
POSTGRES_PASSWORD=$(rand 16)
S3_BUCKET=vault-blobs
S3_REGION=us-east-1
S3_ACCESS_KEY=ak$(rand 6)
S3_SECRET_KEY=$(rand 16)
SECRET_KEY_BASE=$(rand 64)
SITE_ADDRESS=localhost
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=https://localhost:$HTTPS_PORT
CORS_ORIGINS=https://localhost:$HTTPS_PORT
ENV
# Optional image overrides pass through (MINIO_IMAGE / MC_IMAGE).
for v in MINIO_IMAGE MC_IMAGE; do [ -n "${!v:-}" ] && echo "$v=${!v}" >>"$ENVF"; done
dc() { docker compose --env-file "$ENVF" -p "$PROJECT" "$@"; }

cleanup() {
  rc=$?
  if [ "$KEEP" != "--keep" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$ENVF"
  echo "[smoke] exit code $rc"
  exit $rc
}
trap cleanup EXIT

echo "[smoke] 0. compose must fail fast when required vars are unset"
if docker compose -p "${PROJECT}-nokeys" config -q >/dev/null 2>&1; then
  echo "[smoke] FAIL: compose accepted an empty environment"; exit 1
fi
echo "[smoke]    ok (refused)"

echo "[smoke] 1. build + up"
dc up -d --build
echo "[smoke] 2. wait for api healthy (container healthcheck)"
for i in $(seq 1 60); do
  st=$(dc ps api --format '{{.Health}}' 2>/dev/null || true)
  [ "$st" = healthy ] && break
  sleep 3
  [ "$i" = 60 ] && { echo "[smoke] FAIL: api never healthy"; dc logs --tail 40 api; exit 1; }
done
echo "[smoke] 3. db migrations (RAILS_ENV=production)"
dc exec -T api bundle exec rake db:migrate
echo "[smoke] 4. health through Caddy (https://localhost:$HTTPS_PORT/health)"
for i in $(seq 1 30); do
  body=$(curl -ksS --max-time 5 "https://localhost:$HTTPS_PORT/health" 2>/dev/null || true)
  [ "$body" = '{"ok":true}' ] && break
  sleep 2
  [ "$i" = 30 ] && { echo "[smoke] FAIL: health via caddy returned '$body'"; dc logs --tail 20 caddy; exit 1; }
done
echo "[smoke]    $body"
echo "[smoke] 5. unauthenticated request must be rejected"
code=$(curl -ks -o /dev/null -w '%{http_code}' "https://localhost:$HTTPS_PORT/api/v1/vaults")
[ "$code" = 401 ] || { echo "[smoke] FAIL: expected 401 got $code"; exit 1; }
echo "[smoke]    401 ok"
echo "[smoke] 6. bucket exists in MinIO (created by minio-init)"
set -a; . "$ENVF"; set +a
dc run --rm --no-deps minio-init ls "local/$S3_BUCKET" >/dev/null
echo "[smoke]    ok"
echo "[smoke] 7. authenticated flow (real WebAuthn registration -> blob round trip -> delete account)"
dc exec -T -e SMOKE_ORIGIN="https://localhost:$HTTPS_PORT" api bundle exec ruby - <smoke/flow.rb
echo "[smoke] 8. independent post-checks"
left=$(dc run --rm --no-deps minio-init ls --recursive "local/$S3_BUCKET" | wc -l | tr -d ' ')
[ "$left" = 0 ] || { echo "[smoke] FAIL: $left objects left in bucket"; exit 1; }
echo "[smoke]    bucket empty (mc ls)"
users=$(dc exec -T db psql -U vault -d vault_production -tAc "select count(*) from users where email like 'smoke-%'")
[ "$users" = 0 ] || { echo "[smoke] FAIL: smoke user rows remain"; exit 1; }
echo "[smoke]    smoke user rows in postgres: 0"
echo "[smoke] 9. worker alive (sidekiq booted, no crash loop)"
dc ps worker --format '{{.Status}}' | grep -q '^Up' || { echo "[smoke] FAIL: worker not up"; dc logs --tail 30 worker; exit 1; }
if dc logs worker 2>&1 | grep -q 'terminated with exception'; then
  echo "[smoke] FAIL: sidekiq thread crashed"; dc logs --tail 30 worker; exit 1
fi
echo "[smoke]    no sidekiq thread crashes in worker log"
echo "[smoke] PASS"
