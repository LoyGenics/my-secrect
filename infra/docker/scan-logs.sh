#!/usr/bin/env bash
# Fails if a server log contains secret material.
#
#   scan-logs.sh LOG_FILE NEEDLES_FILE [ENV_FILE]
#
# LOG_FILE      `docker compose logs` output of every container (api, worker,
#               caddy, db, redis, minio, minio-init).
# NEEDLES_FILE  exact values a real client saw on the wire: session tokens,
#               WebAuthn challenges/assertions, ciphertext fields, encrypted
#               manifests, presigned-URL signatures, passphrase, recovery key,
#               plaintext markers (written by verify-restore/client.ts).
# ENV_FILE      the stack's env file: its secrets must not appear either.
#
# Also applies pattern rules (any session token, presigned signature/credential,
# bearer header, PEM private key, plaintext marker, an unfiltered sensitive
# parameter, any Rails "Parameters:" line). Long needles are also checked as
# three 32-char windows, so a truncated echo is still caught. Prints only
# which rule matched and where, never the matched value.
set -euo pipefail
LOG=${1:?LOG_FILE required}
NEEDLES=${2:?NEEDLES_FILE required}
ENVF=${3:-}
[ -s "$LOG" ] || { echo "[scan] FAIL: log file is empty" >&2; exit 1; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/a16-scan.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# Fixed-string needles: full values + 32-char windows of long ones; no blank lines.
{
  cat "$NEEDLES"
  if [ -n "$ENVF" ]; then
    for v in POSTGRES_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY SECRET_KEY_BASE; do
      grep -E "^$v=" "$ENVF" | head -1 | cut -d= -f2-
    done
  fi
} | awk 'length($0) >= 8 { print; n = length($0); if (n > 64) { print substr($0, 1, 32); print substr($0, int(n / 2) - 16, 32); print substr($0, n - 31, 32) } }' \
  | sort -u >"$WORK/fixed"
FIXED=$(wc -l <"$WORK/fixed" | tr -d ' ')
[ "$FIXED" -gt 0 ] || { echo "[scan] FAIL: no needles to look for" >&2; exit 1; }

# Positive control: the matcher must find a needle planted in a copy.
{ echo 'control line'; echo "planted $(head -1 "$WORK/fixed") here"; } >"$WORK/control"
grep -qF -f "$WORK/fixed" "$WORK/control" || { echo "[scan] FAIL: positive control not detected" >&2; exit 1; }

fail=0
rc=0; hits=$(grep -nF -f "$WORK/fixed" "$LOG") || rc=$?
[ "$rc" -le 1 ] || { echo "[scan] FAIL: needle search could not run (grep exit $rc)" >&2; exit 1; }
hits=$(printf '%s' "$hits" | cut -d: -f1 | head -20)
if [ -n "$hits" ]; then
  fail=1
  for n in $hits; do echo "[scan] LEAK exact-needle at log line $n (service: $(sed -n "${n}p" "$LOG" | cut -d'|' -f1 | tr -d ' '))"; done
fi

rule() { # NAME ERE ; grep status 2 (bad pattern/IO) is a hard failure, never "no match"
  local lines rc=0
  lines=$(grep -nE -e "$2" "$LOG") || rc=$?
  [ "$rc" -le 1 ] || { echo "[scan] FAIL: rule '$1' could not run (grep exit $rc)" >&2; exit 1; }
  lines=$(printf '%s' "$lines" | cut -d: -f1 | head -5)
  if [ -n "$lines" ]; then
    fail=1
    echo "[scan] LEAK rule '$1' at log line(s) $(echo $lines | tr ' ' ',')"
  fi
}
rule 'session token'            'sess_[0-9a-f]{64}'
rule 'presigned signature'      'X-Amz-Signature='
rule 'presigned credential'     'X-Amz-Credential='
rule 'bearer header'            '[Bb]earer [A-Za-z0-9_.~+/-]{10,}'
rule 'PEM private key'          '-----BEGIN [A-Z ]*PRIVATE KEY-----'
rule 'plaintext marker'         'MARK-[0-9a-f]{16}'
rule 'unfiltered parameter'     '"(encrypted_[a-z_]+|ciphertext|token|challenge|credential|code|recovery_code|totp_secret|signature|passphrase|password|clientDataJSON|attestationObject|authenticatorData)"[[:space:]]*(:|=>)[[:space:]]*"[^[]'
rule 'rails parameters line'    'Parameters: \{'

requests=$(grep -c '"event":"request"' "$LOG" || true)
echo "[scan] scanned $(wc -l <"$LOG" | tr -d ' ') log lines from $(cut -d'|' -f1 "$LOG" | tr -d ' ' | grep -v '^$' | sort -u | tr '\n' ' ')"
echo "[scan] $FIXED fixed needles (client-observed secrets + env secrets) + 8 pattern rules; positive control detected"
echo "[scan] structured request lines: $requests"
[ "$requests" -gt 0 ] || { echo "[scan] FAIL: no structured request lines (is the API logging to stdout?)" >&2; exit 1; }
if [ "$fail" != 0 ]; then echo "[scan] FAIL: secret material found in logs"; exit 1; fi
echo "[scan] PASS: no secret material in any container log"
