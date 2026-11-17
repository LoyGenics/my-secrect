#!/usr/bin/env bash
# Runs apps/api/spec/requests/api/v1/blobs_minio_spec.rb against a REAL MinIO:
# starts a throwaway MinIO container (random credentials, host port
# RSPEC_MINIO_PORT, default 19690), runs the spec, removes the container.
# Needs docker, ruby 3.3 + bundle in apps/api, and a local Postgres: pass the
# usual RSpec env (RAILS_ENV=test DATABASE_URL=... with the schema loaded).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT=${RSPEC_MINIO_PORT:-19690}
NAME=${RSPEC_MINIO_NAME:-rspec-minio-$$}
IMAGE=${MINIO_IMAGE:-cgr.dev/chainguard/minio:latest}
ACCESS="ak$(openssl rand -hex 6)"
SECRET="$(openssl rand -hex 16)"
cleanup() { rc=$?; docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "[rspec-minio] exit code $rc"; exit $rc; }
trap cleanup EXIT
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:9000" -e MINIO_ROOT_USER="$ACCESS" -e MINIO_ROOT_PASSWORD="$SECRET" \
  "$IMAGE" server /data >/dev/null
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/minio/health/ready" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 30 ] && { echo "[rspec-minio] MinIO not ready"; docker logs "$NAME" | tail -20; exit 1; }
done
cd "$ROOT/apps/api"
MINIO_SPEC_ENDPOINT="http://127.0.0.1:$PORT" MINIO_SPEC_BUCKET=rspec-blobs \
  MINIO_SPEC_ACCESS_KEY="$ACCESS" MINIO_SPEC_SECRET_KEY="$SECRET" \
  bundle exec rspec spec/requests/api/v1/blobs_minio_spec.rb "$@"
