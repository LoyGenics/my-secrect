# End-to-end tests

- `export-import-roundtrip.test.mjs` — runs with plain Node (`npm test`):
  create -> encrypt -> export v1 -> import -> decrypt, no server.
- Full E2E (two devices syncing through the Rails API + MinIO) is NOT
  automated yet: it needs `docker compose up` + a seeded API + two
  clients. That harness belongs here (`tests/end-to-end/`) in Phase 2.
