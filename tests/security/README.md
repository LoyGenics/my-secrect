# Security tests

Plain Node 20+ tests (`node --test tests/security/`). No server, no
browser, no secrets. Run after `npm install` (needs
`libsodium-wrappers-sumo` from the workspace).

## What is here

- `reject-tampering.test.mjs` — every case must REJECT: invalid
  ciphertext, tampered metadata, wrong key, wrong passphrase KEK,
  corrupted backup, replayed old revision, swapped encrypted payload.
  Plus one control case proving a valid envelope still opens.

## Honesty note

These tests exercise libsodium directly with the adapter's exact
production parameters, and mirror the envelope/binding rules from
`specs/encryption-format.md` inline — they CANNOT import the TypeScript
adapter (`node --test` has no TS loader). A green run proves the AEAD
construction and the specified rules reject tampering; it does NOT prove
the apps call these checks. See `docs/security-review.md` (M5) and the
header of each test file.

## Wiring

`tests/security/` is NOT yet in the root `package.json` `test` script —
add it there (coordinator) so `npm test` covers it. Until then run:

```sh
node --test tests/security/
```
