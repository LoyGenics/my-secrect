#!/usr/bin/env bash
# Proves the BUILT web client works under the strict Content-Security-Policy
# Caddy serves (infra/docker/Caddyfile): builds apps/web, boots the compose
# stack with a throwaway random env (own project, default a16-csp, host ports
# 19544/19581, test-only Mailpit API on 127.0.0.1:19591), checks the static-file headers, then drives the real UI in
# Chromium (verify-web-csp/browser.mjs) and fails on any CSP violation.
# Finally scans every container log for secrets (env secrets + pattern rules).
#
#   infra/docker/verify-web-csp.sh [--keep]      (SKIP_WEB_BUILD=1 reuses apps/web/dist)
#
# Needs: docker compose v2, node >= 20 with `npm ci` at the repo root, and
# Playwright's Chromium (npx playwright install chromium).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_DIR="$HERE"
PROJECT=${CSP_PROJECT:-a16-csp}
HTTPS_PORT=${CSP_HTTPS_PORT:-19544}
HTTP_PORT=${CSP_HTTP_PORT:-19581}
MAILPIT_PORT=${CSP_MAILPIT_PORT:-19591}
ORIGIN="https://localhost:$HTTPS_PORT"
KEEP=${1:-}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/a16-csp.XXXXXX")
ENVF="$WORK/env"
export WEB_DIST="$ROOT/apps/web/dist"
. "$HERE/lib/stack.sh"
say() { echo "[web-csp] $*"; }
fail() { echo "[web-csp] FAIL: $*" >&2; exit 1; }
cleanup() {
  rc=$?
  if [ "$KEEP" != "--keep" ]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; fi
  say "exit code $rc"
  exit $rc
}
trap cleanup EXIT

say "commit $(git -C "$ROOT" rev-parse --short HEAD), project $PROJECT, $(date -u +%FT%TZ)"
if [ "${SKIP_WEB_BUILD:-}" != 1 ]; then
  say "1. build apps/web (tsc + vite build)"
  (cd "$ROOT" && npm --workspace apps/web run build >"$WORK/build.log" 2>&1) || { tail -30 "$WORK/build.log"; fail "web build"; }
fi
[ -f "$WEB_DIST/index.html" ] || fail "no $WEB_DIST/index.html"
grep -q '<script>' "$WEB_DIST/index.html" && fail "built index.html has an inline <script>"
say "   dist: $(ls "$WEB_DIST/assets" | tr '\n' ' ')(no inline script in index.html)"

say "2. boot the stack (Caddy serves $WEB_DIST read-only)"
write_env "$HTTPS_PORT" "$HTTP_PORT" "$MAILPIT_PORT"
dc up -d --build >"$WORK/up.log" 2>&1 || { cat "$WORK/up.log"; fail "compose up"; }
wait_healthy api
dc exec -T api bundle exec rake db:migrate >/dev/null
wait_caddy "$ORIGIN"
caddy_root_ca "$WORK/caddy-root.crt"

say "3. static headers"
hdr() { curl -sS -D - -o /dev/null --cacert "$WORK/caddy-root.crt" "$1" | tr -d '\r'; }
doc=$(hdr "$ORIGIN/")
csp=$(echo "$doc" | grep -i '^content-security-policy:' | cut -d' ' -f2-)
[ "$(echo "$doc" | grep -ci '^content-security-policy:')" = 1 ] || fail "document CSP missing or duplicated"
echo "$csp" | grep -qF "connect-src 'self' https://s3.localhost:$HTTPS_PORT;" || fail "CSP connect-src does not name the S3 endpoint"
echo "$csp" | grep -qE "unsafe-inline|'unsafe-eval'" && fail "CSP allows unsafe-inline/unsafe-eval"
for h in 'strict-transport-security: max-age=31536000; includesubdomains' 'x-frame-options: deny' 'x-content-type-options: nosniff' \
         'referrer-policy: no-referrer' 'cross-origin-opener-policy: same-origin' 'cross-origin-resource-policy: same-origin' 'cache-control: no-cache'; do
  echo "$doc" | tr 'A-Z' 'a-z' | grep -qxF "$h" || fail "document header missing: $h"
done
asset=$(ls "$WEB_DIST/assets" | grep '\.js$' | head -1)
echo "$(hdr "$ORIGIN/assets/$asset")" | tr 'A-Z' 'a-z' | grep -qxF 'cache-control: public, max-age=31536000, immutable' || fail "hashed asset not immutable"
[ "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$WORK/caddy-root.crt" "$ORIGIN/assets/does-not-exist.js")" = 404 ] || fail "missing asset is not a 404"
s3=$(curl -sS -D - -o /dev/null --cacert "$WORK/caddy-root.crt" "https://s3.localhost:$HTTPS_PORT/" | tr -d '\r' | tr 'A-Z' 'a-z')
echo "$s3" | grep -qxF "content-security-policy: default-src 'none'; sandbox; frame-ancestors 'none'" || fail "s3 site lacks the sandbox CSP"
say "   document: CSP (enforced, 1x), HSTS, XFO DENY, nosniff, no-referrer, COOP/CORP same-origin, no-cache"
say "   /assets: immutable; missing asset 404; s3.<site>: sandbox CSP"
say "   CSP: $csp"

say "4. Chromium drives the built app under the policy"
: >"$WORK/needles.txt"
(cd "$ROOT" && CSP_APP_ORIGIN="$ORIGIN" CSP_NEEDLES="$WORK/needles.txt" CSP_SCREENSHOT_DIR="${CSP_SCREENSHOT_DIR:-$WORK}" node "$HERE/verify-web-csp/browser.mjs")

say "5. log scan"
collect_logs "$WORK/logs.txt"
"$HERE/scan-logs.sh" "$WORK/logs.txt" "$WORK/needles.txt" "$ENVF" | sed 's/^/[web-csp]    /'
say "PASS"
