#!/usr/bin/env bash
# Scenario L, end to end, from nothing:
#   fresh compose project + fresh volumes -> deploy -> migrate -> hardening
#   checks -> REAL client: account (WebAuthn) + vault + encrypted items +
#   encrypted media blob through the public API -> restart every service ->
#   fresh device verifies -> backup (pg_dump + MinIO mirror) -> DESTROY all
#   volumes -> restore -> fresh device verifies again (recovery key) ->
#   DB/object fingerprints identical -> account deletion (what goes, what
#   stays, and that an older backup brings it back) -> scan all container
#   logs for secrets.
# Exits non-zero on any mismatch. Throwaway random env, own compose project
# (default a16-scenl), host ports 19543/19580; never touches another stack.
#
#   infra/docker/verify-restore.sh [--keep]
#
# Needs: docker compose v2, node >= 20 with `npm ci` done at the repo root, openssl, curl.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_DIR="$HERE"
PROJECT=${VR_PROJECT:-a16-scenl}
HTTPS_PORT=${VR_HTTPS_PORT:-19543}
HTTP_PORT=${VR_HTTP_PORT:-19580}
ORIGIN="https://localhost:$HTTPS_PORT"
KEEP=${1:-}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/a16-scenl.XXXXXX")
ENVF="$WORK/env"
LOGS="$WORK/container-logs.txt"
export SCENARIO_DIR="$WORK" SCENARIO_ORIGIN="$ORIGIN"
. "$HERE/lib/stack.sh"
say() { echo "[scenario-L] $*"; }
fail() { echo "[scenario-L] FAIL: $*" >&2; exit 1; }

cleanup() {
  rc=$?
  if [ "$KEEP" != "--keep" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  else
    say "kept stack '$PROJECT' and work dir $WORK"
  fi
  say "exit code $rc"
  exit $rc
}
trap cleanup EXIT

client() { (cd "$ROOT" && NODE_EXTRA_CA_CERTS="$WORK/caddy-root.crt" node --import tsx "$HERE/verify-restore/client.ts" "$@"); }

# Every table: row count + md5 over the rows' text form (bytea as hex, so
# ciphertext is covered). Prints counts and digests only.
db_fingerprint() {
  local t
  for t in $(dc exec -T db psql -U vault -d vault_production -tAc "select tablename from pg_tables where schemaname='public' order by 1"); do
    dc exec -T db psql -U vault -d vault_production -tAc \
      "select '$t ' || count(*) || ' ' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from \"$t\" x"
  done
}
# Every object: key, size, sha256 (bytes read back through mc).
object_fingerprint() {
  local bucket key
  bucket=$(envval S3_BUCKET)
  for key in $(dc run -T --rm --no-deps minio-init ls --recursive "local/$bucket" | awk '{print $NF}'); do
    echo "$key $(dc run -T --rm --no-deps minio-init cat "local/$bucket/$key" | shasum -a 256 | cut -d' ' -f1)"
  done
}

say "commit $(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- infra apps/api/config || echo ' (+ uncommitted infra/api-config changes)'), project $PROJECT, $(date -u +%FT%TZ)"
write_env "$HTTPS_PORT" "$HTTP_PORT"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ] || fail "project $PROJECT already has volumes; not a clean environment"

say "1. compose refuses an environment without the required variables"
if docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" -p "$PROJECT-nokeys" config -q >/dev/null 2>&1; then
  fail "compose accepted an empty environment"
fi

say "2. deploy: build + up (fresh volumes), migrate"
dc up -d --build >"$WORK/up.log" 2>&1 || { cat "$WORK/up.log"; fail "compose up"; }
wait_healthy api
dc exec -T api bundle exec rake db:migrate >/dev/null
[ "$(dc exec -T api bundle exec rake db:migrate:status | grep -cE '^\s+down')" = 0 ] || fail "pending migrations"
say "   migrations: $(dc exec -T api bundle exec rake db:migrate:status | grep -cE '^\s+up') up, 0 down"
wait_healthy worker
wait_caddy "$ORIGIN"
caddy_root_ca "$WORK/caddy-root.crt"
say "   api healthy, worker healthy (sidekiq heartbeat), Caddy serves /health over TLS"

say "3. hardening checks"
# 3a. the API refuses to boot with weak/missing config (no defaults)
boot_refusal() { # LABEL EXPECTED_MESSAGE -e VAR=VALUE...
  local label=$1 want=$2 out; shift 2
  if out=$(dc run --rm --no-deps -T "$@" api bundle exec ruby -e 'require "./config/environment"' 2>&1); then
    fail "API booted with $label"
  fi
  echo "$out" | grep -qF "$want" || { echo "$out" | tail -5 >&2; fail "boot refusal for $label did not name the problem"; }
  say "   boot refused: $label -> \"$want\""
}
boot_refusal 'SECRET_KEY_BASE=CHANGE_ME' 'Placeholder value (CHANGE_ME) in: SECRET_KEY_BASE' -e SECRET_KEY_BASE=CHANGE_ME
boot_refusal 'short SECRET_KEY_BASE' 'SECRET_KEY_BASE must be at least 64 characters' -e SECRET_KEY_BASE=0123456789abcdef
boot_refusal 'empty REDIS_URL' 'Missing required environment variables: REDIS_URL' -e REDIS_URL=
boot_refusal 'CORS_ORIGINS=*' 'CORS_ORIGINS must list exact origins, never *' -e 'CORS_ORIGINS=*'
boot_refusal 'empty S3_BUCKET' 'S3_BUCKET is required but not set' -e S3_BUCKET=
# 3b. only Caddy publishes ports
published=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | awk '$2 ~ /->/ {print $1}' | sort -u | tr '\n' ' ')
[ "$published" = "caddy " ] || fail "services with published ports: '$published' (want only caddy)"
say "   published ports: caddy only ($(docker port "$(dc ps -q caddy)" | tr '\n' ' '))"
# 3c. internal networks, segmentation, no egress
for n in proxy backend; do
  [ "$(docker network inspect "${PROJECT}_$n" --format '{{.Internal}}')" = true ] || fail "network $n is not internal"
done
dc exec -T caddy nc -z -w 3 api 3000 || fail "caddy cannot reach api (control)"
if dc exec -T caddy nc -z -w 3 db 5432 2>/dev/null; then fail "caddy can reach postgres"; fi
if dc exec -T caddy nc -z -w 3 redis 6379 2>/dev/null; then fail "caddy can reach redis"; fi
if dc exec -T api curl -sS -m 5 -o /dev/null https://example.com 2>/dev/null; then fail "api has internet egress"; fi
say "   networks proxy+backend internal; caddy reaches api but not db/redis; api has no internet egress"
# 3d. TLS versions and HTTP -> HTTPS
tls_probe() { node -e '
  const tls = require("node:tls");
  const [port, v] = process.argv.slice(1);
  const s = tls.connect({ host: "127.0.0.1", port: +port, servername: "localhost", minVersion: v, maxVersion: v, ciphers: "DEFAULT@SECLEVEL=0", rejectUnauthorized: false },
    () => { console.log(s.getProtocol()); s.end(); });
  s.on("error", () => { console.log("refused"); });' "$HTTPS_PORT" "$1"; }
[ "$(tls_probe TLSv1.3)" = TLSv1.3 ] || fail "TLS 1.3 not offered"
[ "$(tls_probe TLSv1.2)" = TLSv1.2 ] || fail "TLS 1.2 not offered"
[ "$(tls_probe TLSv1.1)" = refused ] || fail "TLS 1.1 accepted"
[ "$(tls_probe TLSv1)" = refused ] || fail "TLS 1.0 accepted"
redirect=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HTTP_PORT/health")
[ "$redirect" = 308 ] || fail "plain HTTP answered $redirect, want 308 redirect"
say "   TLS 1.3 + 1.2 accepted, 1.1 + 1.0 refused; plain HTTP -> 308 to HTTPS"
# 3e. security headers on the API (single values, Caddy's replace the app's)
hdrs=$(curl -sS -D - -o /dev/null --cacert "$WORK/caddy-root.crt" "$ORIGIN/api/v1/vaults" | tr -d '\r' | tr 'A-Z' 'a-z')
for h in 'strict-transport-security: max-age=31536000; includesubdomains' 'x-content-type-options: nosniff' 'x-frame-options: deny' \
         'referrer-policy: no-referrer' 'cache-control: no-store' "content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"; do
  [ "$(echo "$hdrs" | grep -cxF "$h")" = 1 ] || fail "API response header missing or duplicated: $h"
done
echo "$hdrs" | grep -q '^server:' && fail "Server header present"
echo "$hdrs" | head -1 | grep -q ' 401' || fail "unauthenticated /api/v1/vaults not 401"
say "   API headers: HSTS, nosniff, XFO DENY, no-referrer, no-store, CSP default-src 'none' (each exactly once); no Server header; unauthenticated -> 401"

say "4. REAL client seeds the account through the public API"
client seed

say "5. restart every service"
dc restart >/dev/null 2>&1
wait_healthy api; wait_healthy worker; wait_caddy "$ORIGIN"
say "   all services back (api + worker healthy)"
client verify after-restart

say "6. fingerprint + backup"
BEFORE_DB=$(db_fingerprint); BEFORE_OBJ=$(object_fingerprint)
say "   tables: $(echo "$BEFORE_DB" | wc -l | tr -d ' '), rows: $(echo "$BEFORE_DB" | awk '{s+=$2} END {print s}'), objects: $(echo "$BEFORE_OBJ" | grep -c . || true)"
echo "$BEFORE_DB" | awk '$2 > 0 {printf "[scenario-L]     %-22s %4d rows  md5 %s\n", $1, $2, $3}'
[ "$(echo "$BEFORE_OBJ" | grep -c .)" -ge 3 ] || fail "expected the media blob's chunks in MinIO"
ENV_FILE="$ENVF" PROJECT="$PROJECT" "$HERE/backup.sh" "$WORK/backup" | sed 's/^/[scenario-L]    /'
collect_logs "$LOGS"

say "7. DESTROY: compose down -v (containers, networks, ALL volumes)"
dc down -v --remove-orphans >/dev/null 2>&1
left=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')
[ "$left" = 0 ] || fail "$left volumes survived down -v"
dc up -d db >/dev/null 2>&1; wait_healthy db
[ "$(dc exec -T db psql -U vault -d vault_production -tAc "select count(*) from pg_tables where schemaname='public'")" = 0 ] || fail "fresh database is not empty"
say "   0 project volumes left; fresh Postgres has 0 tables"

say "8. restore (restore.sh), then start the full stack"
ENV_FILE="$ENVF" PROJECT="$PROJECT" "$HERE/restore.sh" --yes "$WORK/backup" | sed 's/^/[scenario-L]    /'
dc up -d >/dev/null 2>&1
wait_healthy api; wait_healthy worker; wait_caddy "$ORIGIN"
caddy_root_ca "$WORK/caddy-root.crt" # new caddy_data volume => new local CA
[ "$(dc exec -T api bundle exec rake db:migrate:status | grep -cE '^\s+down')" = 0 ] || fail "restored schema has pending migrations"

say "9. compare fingerprints"
AFTER_DB=$(db_fingerprint); AFTER_OBJ=$(object_fingerprint)
[ "$AFTER_DB" = "$BEFORE_DB" ] || { diff <(echo "$BEFORE_DB") <(echo "$AFTER_DB") >&2 || true; fail "database differs after restore"; }
[ "$AFTER_OBJ" = "$BEFORE_OBJ" ] || { diff <(echo "$BEFORE_OBJ") <(echo "$AFTER_OBJ") >&2 || true; fail "objects differ after restore"; }
say "   every table: same row count + md5; every object: same key + sha256"

say "10. fresh device after restore (recovery key path)"
client verify after-restore-recovery

say "11. account deletion on the restored stack: what goes, what stays"
client delete
psqlc() { dc exec -T db psql -U vault -d vault_production -tAc "$1"; }
for t in users vaults items item_versions sync_events blobs blob_parts sessions authenticators devices device_checkpoints \
         key_envelopes shares passkey_challenges mfa_challenges recovery_challenges recovery_verifiers recovery_codes; do
  [ "$(psqlc "select count(*) from $t")" = 0 ] || fail "$t still has rows after account deletion"
done
[ "$(object_fingerprint | grep -c . || true)" = 0 ] || fail "objects left in the bucket after account deletion"
audit_left=$(psqlc "select count(*) from audit_events")
[ "$(psqlc "select count(*) from audit_events where user_id is not null or device_id is not null")" = 0 ] || fail "audit events still linked to the deleted user/devices"
say "    18 account tables: 0 rows; bucket: 0 objects; audit_events: $audit_left rows kept with user_id/device_id NULL ($(psqlc "select string_agg(distinct event_type, ',' order by event_type) from audit_events"))"
in_backup=$(dc exec -T db pg_restore -a -t users -f - <"$WORK/backup/db.dump" | grep -c 'scenario-l-' || true)
[ "$in_backup" = 1 ] || fail "expected the deleted account in the pre-deletion backup (got $in_backup)"
say "    the pre-deletion backup still holds the account row (until that backup is deleted)"

say "12. restoring that backup brings the deleted account back (why backups need rotation + a deletion re-run)"
dc stop api worker >/dev/null 2>&1
ENV_FILE="$ENVF" PROJECT="$PROJECT" "$HERE/restore.sh" --yes "$WORK/backup" >/dev/null 2>&1
[ "$(psqlc "select count(*) from users")" = 1 ] && [ "$(object_fingerprint | grep -c .)" = "$(echo "$BEFORE_OBJ" | grep -c .)" ] || fail "re-restore"
dc start api worker >/dev/null 2>&1; wait_healthy api
say "    after re-restore: users=1, objects=$(echo "$BEFORE_OBJ" | grep -c .) — deleted data is back"

say "13. log scan (all containers, before destroy + after restore)"
collect_logs "$LOGS"
"$HERE/scan-logs.sh" "$LOGS" "$WORK/needles.txt" "$ENVF" | sed 's/^/[scenario-L]    /'
say "    sample request line: $(grep -m1 -o '{"event":"request".*}' "$LOGS" | sed -E 's/"request_id":"[^"]+"/"request_id":"…"/')"

say "PASS: deploy, seed, restart, backup, destroy, restore; every record and blob present and decryptable client-side; account deletion verified; logs clean"
