#!/usr/bin/env bash
# Restore a backup made by backup.sh into a compose stack.
#
#   ENV_FILE=./.env [PROJECT=docker] ./restore.sh --yes BACKUP_DIR
#
# DESTRUCTIVE for the target: pg_restore --clean drops and recreates every
# object in vault_production; the bucket is overwritten with the backup
# (objects not in the backup are left alone; add MIRROR_REMOVE=1 to delete
# them). Verifies the backup's sha256 manifest first. Requires --yes.
set -euo pipefail
cd "$(dirname "$0")"
[ "${1:-}" = "--yes" ] || { echo "refusing: pass --yes (restore overwrites the database)" >&2; exit 2; }
SRC=${2:?BACKUP_DIR required}
: "${ENV_FILE:?ENV_FILE is required (the compose env file)}"
PROJECT=${PROJECT:-docker}
dc() { docker compose --env-file "$ENV_FILE" -p "$PROJECT" "$@"; }
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
BUCKET=$(envval S3_BUCKET)
SRC=$(cd "$SRC" && pwd)

echo "[restore] verifying manifest"
( cd "$SRC" && shasum -a 256 -c MANIFEST.sha256 >/dev/null ) || { echo "[restore] FAIL: manifest mismatch" >&2; exit 1; }

echo "[restore] ensuring db, minio and bucket are up"
dc up -d db minio
dc up minio-init >/dev/null
for i in $(seq 1 30); do
  [ "$(dc ps db --format '{{.Health}}')" = healthy ] && break
  sleep 2
done

echo "[restore] postgres <- db.dump (pg_restore --clean --if-exists)"
dc exec -T db pg_restore -U vault -d vault_production --clean --if-exists --no-owner --exit-on-error <"$SRC/db.dump"

echo "[restore] minio <- $SRC/minio"
rm_flag=""; [ "${MIRROR_REMOVE:-0}" = 1 ] && rm_flag="--remove"
dc run --rm --no-deps --user 0 -v "$SRC/minio:/backup:ro" minio-init \
  mirror --overwrite $rm_flag /backup "local/$BUCKET"
echo "[restore] done"
