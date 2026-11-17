#!/usr/bin/env bash
# Boots the real compose stack (throwaway random env, no repo secrets), then
# runs tests/media-e2e/media.e2e.test.mts against it from the HOST through the
# PUBLIC endpoints only (Caddy: https://localhost:PORT and https://s3.localhost:PORT).
# Needs docker, node >= 20 + tsx (npm ci), ruby 3.3 + bundle in apps/api.
# Usage: tests/media-e2e/run.sh [--keep]
#   E2E_TESTS="<files>"  -> run only these node test files (default: media + devices)
#   E2E_LARGE_MIB=96     -> size of the large-file streaming test in devices.e2e.test.mts
#   E2E_BROWSER=1 tests/media-e2e/run.sh   -> instead of the node test, serve apps/web
#   (vite, port E2E_WEB_PORT=5204) and drive the real MediaView in Chromium
#   (Playwright) against the stack: tests/media-e2e/browser.e2e.mjs.
set -euo pipefail
# Same default as tests/e2e-web/stack.ts and tests/sync-e2e/api-harness.ts:
# register.rb runs under apps/api's bundle, which needs Ruby 3.3.
export RBENV_VERSION=${RBENV_VERSION:-3.3.6}
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_DIR="$ROOT/infra/docker"
PROJECT=${E2E_PROJECT:-vmediae2e}
HTTPS_PORT=${E2E_HTTPS_PORT:-19443}
HTTP_PORT=${E2E_HTTP_PORT:-19080}
WEB_PORT=${E2E_WEB_PORT:-5204}
BROWSER=${E2E_BROWSER:-}
APP_ORIGIN=https://localhost:$HTTPS_PORT
[ -n "$BROWSER" ] && APP_ORIGIN=http://localhost:$WEB_PORT
KEEP=${1:-}
ENVF=$(mktemp -t vmedia-env.XXXXXX)
rand() { openssl rand -hex "$1"; }
S3_ACCESS="ak$(rand 6)"
S3_SECRET="$(rand 16)"
cat >"$ENVF" <<ENV
POSTGRES_PASSWORD=$(rand 16)
S3_BUCKET=vault-blobs
S3_PUBLIC_ENDPOINT=https://s3.localhost:$HTTPS_PORT
S3_REGION=us-east-1
S3_ACCESS_KEY=$S3_ACCESS
S3_SECRET_KEY=$S3_SECRET
SECRET_KEY_BASE=$(rand 64)
SITE_ADDRESS=localhost
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=https://localhost:$HTTPS_PORT
CORS_ORIGINS=$APP_ORIGIN
ENV
for v in MINIO_IMAGE MC_IMAGE; do [ -n "${!v:-}" ] && echo "$v=${!v}" >>"$ENVF"; done
dc() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENVF" -p "$PROJECT" "$@"; }
VITE_PID=""
cleanup() {
  rc=$?
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ "$KEEP" = "--keep" ] || dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENVF"
  echo "[media-e2e] exit code $rc"
  exit $rc
}
trap cleanup EXIT

echo "[media-e2e] up (build api image, MinIO, Caddy, Postgres)"
dc up -d --build >/dev/null 2>&1 || { dc up -d --build; exit 1; }
for i in $(seq 1 60); do
  [ "$(dc ps api --format '{{.Health}}' 2>/dev/null || true)" = healthy ] && break
  sleep 3
  [ "$i" = 60 ] && { echo "[media-e2e] api never healthy"; dc logs --tail 40 api; exit 1; }
done
dc exec -T api bundle exec rake db:migrate >/dev/null
for i in $(seq 1 30); do
  [ "$(curl -ksS --max-time 5 "https://localhost:$HTTPS_PORT/health" 2>/dev/null || true)" = '{"ok":true}' ] && break
  sleep 2
  [ "$i" = 30 ] && { echo "[media-e2e] health via caddy failed"; exit 1; }
done
echo "[media-e2e] stack healthy; registering throwaway user (real WebAuthn)"
REG=$(cd "$ROOT/apps/api" && SMOKE_ORIGIN="https://localhost:$HTTPS_PORT" bundle exec ruby "$HERE/register.rb")
E2E_TOKEN=$(printf '%s' "$REG" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).token)')
E2E_VAULT_ID=$(printf '%s' "$REG" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).vault_id)')
cd "$ROOT"
if [ -n "$BROWSER" ]; then
  echo "[media-e2e] starting apps/web (vite) on $APP_ORIGIN"
  ( cd apps/web && exec npx vite --port "$WEB_PORT" --strictPort --host localhost ) >/tmp/media-e2e-vite.log 2>&1 &
  VITE_PID=$!
  for i in $(seq 1 40); do curl -fsS "$APP_ORIGIN" >/dev/null 2>&1 && break; sleep 1; [ "$i" = 40 ] && { echo "vite did not start"; cat /tmp/media-e2e-vite.log; exit 1; }; done
  echo "[media-e2e] running browser test (Chromium)"
  E2E_APP_ORIGIN="$APP_ORIGIN" E2E_API="https://localhost:$HTTPS_PORT/api" E2E_TOKEN="$E2E_TOKEN" \
    node tests/media-e2e/browser.e2e.mjs
else
  echo "[media-e2e] running tests"
  # NODE_TLS_REJECT_UNAUTHORIZED=0 only because Caddy uses its internal CA for `localhost`; throwaway stack.
  # E2E_S3_* = the throwaway stack's storage root credentials: tests use them
  # (tests/media-e2e/s3-admin.mts) to tamper with stored objects as a hostile
  # storage operator would.
  E2E_API="https://localhost:$HTTPS_PORT/api" E2E_ORIGIN="$APP_ORIGIN" \
    E2E_TOKEN="$E2E_TOKEN" E2E_VAULT_ID="$E2E_VAULT_ID" NODE_TLS_REJECT_UNAUTHORIZED=0 \
    E2E_S3_ENDPOINT="https://s3.localhost:$HTTPS_PORT" E2E_S3_BUCKET=vault-blobs \
    E2E_S3_ACCESS_KEY="$S3_ACCESS" E2E_S3_SECRET_KEY="$S3_SECRET" \
    E2E_MINIO_CONTAINER="$(dc ps -q minio)" E2E_DB_CONTAINER="$(dc ps -q db)" \
    E2E_REDIS_CONTAINER="$(dc ps -q redis)" E2E_WORKER_CONTAINER="$(dc ps -q worker)" \
    npx tsx --test --test-concurrency=1 ${E2E_TESTS:-tests/media-e2e/media.e2e.test.mts tests/media-e2e/devices.e2e.test.mts}
fi
