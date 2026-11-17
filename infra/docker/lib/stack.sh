# Shared helpers for the throwaway-stack scripts (verify-restore.sh,
# verify-web-csp.sh). Source it; it defines functions only. Stacks run with
# the TEST-ONLY override docker-compose.test.yml (Mailpit as SMTP server).
#   COMPOSE_DIR  infra/docker (set by the caller)
#   PROJECT      compose project name (the caller's own; never a real stack)
#   ENVF         path of the throwaway env file
. "$COMPOSE_DIR/lib/mail.sh"

# write_env HTTPS_PORT HTTP_PORT MAILPIT_PORT : random secrets, nothing read
# from the repo; a per-run mail CA next to ENVF (mail-tls/). Exports
# MAILPIT_URL for the test clients.
write_env() {
  local https=$1 http=$2 mailpit=$3 tls rand
  tls="$(dirname "$ENVF")/mail-tls"
  mail_tls "$tls"
  export MAILPIT_URL="http://127.0.0.1:$mailpit"
  rand() { openssl rand -hex "$1"; }
  umask 077
  cat >"$ENVF" <<ENV
POSTGRES_PASSWORD=$(rand 16)
S3_BUCKET=vault-blobs
S3_PUBLIC_ENDPOINT=https://s3.localhost:$https
S3_REGION=us-east-1
S3_ACCESS_KEY=ak$(rand 6)
S3_SECRET_KEY=$(rand 16)
SECRET_KEY_BASE=$(rand 64)
SITE_ADDRESS=localhost
HTTP_PORT=$http
HTTPS_PORT=$https
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=https://localhost:$https
CORS_ORIGINS=https://localhost:$https
$(mail_env "$tls" "$mailpit")
ENV
  for v in MINIO_IMAGE MC_IMAGE WEB_DIST; do [ -n "${!v:-}" ] && echo "$v=${!v}" >>"$ENVF"; done
  return 0
}

dc() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_DIR/docker-compose.test.yml" --env-file "$ENVF" -p "$PROJECT" "$@"; }

envval() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }

# wait_healthy SERVICE [TRIES] : container healthcheck reports healthy.
wait_healthy() {
  local svc=$1 tries=${2:-60} i
  for i in $(seq 1 "$tries"); do
    [ "$(dc ps "$svc" --format '{{.Health}}' 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  echo "FAIL: $svc never healthy" >&2
  dc logs --tail 40 "$svc" >&2 || true
  return 1
}

# wait_caddy URL : HTTPS through Caddy answers /health with {"ok":true}.
wait_caddy() {
  local i body
  for i in $(seq 1 40); do
    body=$(curl -ksS --max-time 5 "$1/health" 2>/dev/null || true)
    [ "$body" = '{"ok":true}' ] && return 0
    sleep 2
  done
  echo "FAIL: $1/health never answered via Caddy" >&2
  return 1
}

# caddy_root_ca OUT : Caddy's local CA root (for NODE_EXTRA_CA_CERTS), so
# clients verify the TLS chain instead of disabling verification.
caddy_root_ca() {
  local i
  for i in $(seq 1 20); do
    dc exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$1" 2>/dev/null && [ -s "$1" ] && return 0
    sleep 1
  done
  echo "FAIL: no Caddy local root CA" >&2
  return 1
}

# collect_logs OUT : every container's log of this project, appended.
collect_logs() { dc logs --no-color --timestamps >>"$1" 2>&1 || true; }
