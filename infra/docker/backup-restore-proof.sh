#!/usr/bin/env bash
# Proof: seed (DB rows + one blob object) -> backup -> DESTROY ALL VOLUMES ->
# restore -> assert DB row checksums and object sha256 are identical.
# Uses a throwaway random env and its own compose project (default
# "vbackup"); never touches your real stack/volumes.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT=${PROOF_PROJECT:-vbackup}
HTTPS_PORT=${PROOF_HTTPS_PORT:-19443}
HTTP_PORT=${PROOF_HTTP_PORT:-19080}
WORK=$(mktemp -d -t vbackup.XXXXXX)
ENVF="$WORK/env"
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
for v in MINIO_IMAGE MC_IMAGE; do [ -n "${!v:-}" ] && echo "$v=${!v}" >>"$ENVF"; done
dc() { docker compose --env-file "$ENVF" -p "$PROJECT" "$@"; }
cleanup() { rc=$?; dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; echo "[proof] exit code $rc"; exit $rc; }
trap cleanup EXIT

wait_healthy() {
  for i in $(seq 1 60); do
    [ "$(dc ps "$1" --format '{{.Health}}' 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  echo "[proof] FAIL: $1 never healthy" >&2; return 1
}
db_fingerprint() {
  dc exec -T db psql -U vault -d vault_production -tAc "
    select (select count(*) from users) || '/' || (select count(*) from vaults) || '/' ||
           (select count(*) from blobs) || '/' || (select count(*) from blob_parts) || ' ' ||
           md5(coalesce((select string_agg(id::text||email||status, ',' order by id) from users),'') ||
               coalesce((select string_agg(id::text||owner_id::text, ',' order by id) from vaults),'') ||
               coalesce((select string_agg(id::text||storage_key||status||ciphertext_size::text, ',' order by id) from blobs),'') ||
               coalesce((select string_agg(id::text||object_key, ',' order by id) from blob_parts),''))"
}
object_sha() { dc run -T --rm --no-deps minio-init cat "local/vault-blobs/$1" | shasum -a 256 | cut -d' ' -f1; }

echo "[proof] 1. up + migrate"
dc up -d --build
wait_healthy api
dc exec -T api bundle exec rake db:migrate >/dev/null

echo "[proof] 2. seed: 3 users, 3 vaults, 1 blob with 1 part + a 256 KiB random object in MinIO"
head -c 262144 /dev/urandom >"$WORK/obj.bin"
EXPECT_SHA=$(shasum -a 256 "$WORK/obj.bin" | cut -d' ' -f1)
KEY=$(dc exec -T db psql -U vault -d vault_production -tAq <<'SQL'
with u as (
  insert into users (email, status, created_at, updated_at)
  select 'proof-' || g || '@example.test', 'active', now(), now() from generate_series(1,3) g returning id
), v as (
  insert into vaults (owner_id, key_version, encrypted_metadata, created_at, updated_at)
  select id, 1, decode(md5(random()::text),'hex'), now(), now() from u returning id
), b as (
  insert into blobs (vault_id, storage_key, encrypted_manifest, ciphertext_size, status, created_at, updated_at)
  select (select id from v limit 1), 'vaults/proof/blobs/proof-1', decode(md5(random()::text)||md5(random()::text),'hex'), 262144, 'complete', now(), now() returning id
), p as (
  insert into blob_parts (blob_id, part_number, object_key, ciphertext_size, created_at, updated_at)
  select id, 1, 'vaults/proof/blobs/proof-1/part-00001', 262144, now(), now() from b returning object_key
)
select object_key from p;
SQL
)
KEY=$(echo "$KEY" | tr -d '[:space:]')
[ "$KEY" = "vaults/proof/blobs/proof-1/part-00001" ] || { echo "[proof] FAIL: seed key '$KEY'" >&2; exit 1; }
dc run -T --rm --no-deps minio-init pipe "local/vault-blobs/$KEY" <"$WORK/obj.bin" >/dev/null
BEFORE_DB=$(db_fingerprint)
BEFORE_OBJ=$(object_sha "$KEY")
[ "$BEFORE_OBJ" = "$EXPECT_SHA" ] || { echo "[proof] FAIL: object upload mismatch" >&2; exit 1; }
echo "[proof]    db fingerprint before : $BEFORE_DB"
echo "[proof]    object sha256 before  : $BEFORE_OBJ"

echo "[proof] 3. backup"
ENV_FILE="$ENVF" PROJECT="$PROJECT" ./backup.sh "$WORK/backup"

echo "[proof] 4. DESTROY all volumes (docker compose down -v) and bring up an EMPTY stack"
dc down -v --remove-orphans >/dev/null 2>&1
dc up -d --build
wait_healthy api
EMPTY_USERS=$(dc exec -T db psql -U vault -d vault_production -tAc "select count(*) from information_schema.tables where table_name='users'")
[ "$EMPTY_USERS" = 0 ] || { echo "[proof] FAIL: fresh DB is not empty" >&2; exit 1; }
if dc run -T --rm --no-deps minio-init cat "local/vault-blobs/$KEY" >/dev/null 2>&1; then
  echo "[proof] FAIL: object survived volume destruction" >&2; exit 1
fi
echo "[proof]    fresh stack confirmed empty (no users table, object absent)"

echo "[proof] 5. restore"
ENV_FILE="$ENVF" PROJECT="$PROJECT" ./restore.sh --yes "$WORK/backup"

echo "[proof] 6. compare"
AFTER_DB=$(db_fingerprint)
AFTER_OBJ=$(object_sha "$KEY")
echo "[proof]    db fingerprint after  : $AFTER_DB"
echo "[proof]    object sha256 after   : $AFTER_OBJ"
[ "$AFTER_DB" = "$BEFORE_DB" ] || { echo "[proof] FAIL: DB rows differ" >&2; exit 1; }
[ "$AFTER_OBJ" = "$BEFORE_OBJ" ] || { echo "[proof] FAIL: object bytes differ" >&2; exit 1; }
echo "[proof] PASS: DB rows and object bytes identical after destroy + restore"
