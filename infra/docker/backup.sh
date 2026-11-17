#!/usr/bin/env bash
# Server backup: pg_dump (custom format) of the postgres DB + mirror of the
# MinIO bucket, with a sha256 manifest. Run against a RUNNING compose stack.
#
#   ENV_FILE=./.env [PROJECT=docker] ./backup.sh [OUT_DIR]
#
# SECURITY: the output holds ciphertext blobs and account metadata (emails,
# credential ids, session digests). It contains NO keys from this repo, but
# it is NOT encrypted by this script. Encrypt it before it leaves the host
# (e.g. `tar -c DIR | age -r <recipient> > backup.tar.age`, with the age/gpg
# private key stored OFF the server). See docs/deployment.md.
set -euo pipefail
cd "$(dirname "$0")"
: "${ENV_FILE:?ENV_FILE is required (the compose env file)}"
PROJECT=${PROJECT:-docker}
OUT=${1:-./backups/$(date -u +%Y%m%dT%H%M%SZ)}
dc() { docker compose --env-file "$ENV_FILE" -p "$PROJECT" "$@"; }
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
BUCKET=$(envval S3_BUCKET)
[ -n "$BUCKET" ] || { echo "S3_BUCKET missing in $ENV_FILE" >&2; exit 1; }

mkdir -p "$OUT/minio"
OUT=$(cd "$OUT" && pwd)
umask 077
echo "[backup] postgres -> $OUT/db.dump (pg_dump -Fc)"
dc exec -T db pg_dump -U vault -d vault_production -Fc >"$OUT/db.dump"
[ -s "$OUT/db.dump" ] || { echo "[backup] FAIL: empty dump" >&2; exit 1; }

echo "[backup] minio bucket '$BUCKET' -> $OUT/minio (mc mirror)"
dc run --rm --no-deps --user 0 -v "$OUT/minio:/backup" minio-init \
  mirror --overwrite "local/$BUCKET" /backup

echo "[backup] manifest"
( cd "$OUT" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 shasum -a 256 >MANIFEST.sha256 )
echo "[backup] done: $OUT ($(wc -l <"$OUT/MANIFEST.sha256" | tr -d ' ') files)"
