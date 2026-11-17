# Product Requirements — as actually implemented vs missing

> Phase A audit, 17 Nov 2026. Scope is judged against the code on disk.
> The master prompt's sections 4.1–4.7 were not available verbatim to this
> audit; the mapping below is inferred from the repo's own specs, READMEs,
> and code, and is labelled where it is an inference. Nothing here has
> been built, tested, or run.

Status key: ✅ implemented (code, untested) · 🟡 partial · 🔴 missing/scaffold
· ⛔ broken (code contradicts its contract).

## 4.1 Vault items (12 types, 8 modules) — ✅ mostly implemented

- Types: login, passkey, bank_account, card, identity, ssh_key, api_key,
  secure_note, document, media, collection, custom
  (`packages/core/src/types.ts`).
- Desktop `ItemForm.tsx` renders per-type fields for all 12; mobile
  `ItemFormScreen.tsx` likewise (per mobile README; screen not line-read).
- CRUD + favorites + trash/restore/permanent delete + tags + relations
  + local search (Cmd/Ctrl+K palette on desktop) — ✅ in desktop and mobile
  vaults.
- Relations are stored inside the encrypted item JSON, so the server
  cannot see the graph — ✅ by construction.
- Card fields are metadata only: no CVV/PIN/CVC field exists anywhere
  (`ItemForm.tsx:67`, `ItemDetail.tsx:29-31` hides such keys if present,
  `schemas/item-types.ts:7`). ✅ per `specs/threat-model.md` (PCI).
- Gap: `custom` type has no custom-field editor verified in desktop
  `ItemForm` (fields table has a generic notes row); treat as 🟡.

## 4.2 Crypto & key management — ✅ TS path implemented; 🔴 native path unwired

- Argon2id → KEK → Master Key → Vault Key → per-item Item Key;
  XChaCha20-Poly1305, fresh 24 B nonce; recovery key 32 B, SHA-256 KEK —
  ✅ in `packages/crypto-adapters` (libsodium main adapter) and in all
  three client vaults.
- ⛔ Parameter split: TS uses INTERACTIVE (ops 2, mem 64 MiB);
  Rust `crypto-core` uses SENSITIVE. No shared test vectors; a KEK from
  one does not match the other.
- 🔴 No Rust bindings in any TS app; `secretstream` exists only in Rust
  and is used by nothing; TS file encryption uses per-chunk AEAD instead.
- Change passphrase (re-wrap Master Key, items untouched) ✅ desktop,
  mobile, extension. Key rotation beyond that (Vault/Master rotation,
  re-encryption on compromise) 🔴 not implemented anywhere.
- Separate vaults per client (desktop/web localStorage, extension
  chrome.storage, mobile AsyncStorage) — 🟡 until sync unifies them.

## 4.3 Sync & offline — 🟡 engine implemented, ⛔ end-to-end broken

- Offline queue (FIFO, deduped, persisted), checkpoint, keep-both
  conflicts, tombstones, AEAD-verify-before-apply — ✅ in
  `packages/sync/src/index.ts` + `sync-client.ts` (code only).
- Server: revision-checked append-only upsert, 409 on stale base, pull
  with cursor, limit 500 — ✅ in `apps/api` (code only).
- ⛔ `Sync::Pull` omits `encrypted_payload`/`encrypted_item_key`, so the
  client skips every pulled event; sync can never deliver remote changes.
- ⛔ No app imports `SyncClient` or `VaultApiClient` — sync is not wired
  into desktop, mobile, web, or extension UI at all.
- ⛔ Sync/device signatures: `signature` column exists, nothing writes or
  verifies it; `specs/sync-protocol.md` claim "sync event được ký" is false
  in code.
- Checkpoint hash is always `null` client-side; `device_checkpoints` table
  is never written by any code read.

## 4.4 Sharing — 🟡 model only, 🔴 not production-ready

- Share model (`read`/`write`, `active`/`revoked`/`pending`), validation,
  revoke (deletes envelopes; cannot erase recipient copies) — ✅ as a model
  (`packages/core/src/sharing.ts`, `Sharing::Create/Revoke`, `SharesController`).
- 🔴 No HPKE or any key-exchange: `Sharing::Create` accepts a null
  `encrypted_key` and still creates an ACTIVE share; no recipient public
  key exists anywhere (passkey `Authenticator` records are never created).
- Desktop `SharesView.tsx` warns about this honestly — but the component
  is orphaned (never rendered by `App.tsx`), so users cannot even see it.
- Revocation does not rotate keys or notify recipients' clients to delete
  local copies (server comment admits this).

## 4.5 Media & files — 🟡 crypto helpers implemented, 🔴 no working flow

- Chunked encrypted upload/download, encrypted manifest, hash + AEAD
  per-chunk verify, resumable upload state, video range→chunk mapping —
  ✅ in `packages/storage/src/upload.ts` (code only).
- Server presigned upload/download sessions (5 min), 5 GiB/blob cap —
  ✅ in `apps/api/app/domains/blobs/*` (code only).
- 🔴 No File Key persistence: `BlobManifest` has no wrapped-File-Key field,
  so a downloaded file cannot be decrypted by any code path.
- 🔴 No upload/download UI wired: `MediaView.tsx` is orphaned; item forms
  only carry manual `blob_id`/`sha256` metadata fields; no file picker
  calls `encryptChunks`/`uploadPart` anywhere.
- 🔴 Thumbnails: spec says client-generated + encrypted before upload;
  no thumbnail code exists outside a comment.
- Chunk size mismatch: client 1 MiB (`upload.ts`) vs server `PART_BYTES`
  8 MiB (`upload_session.rb`).

## 4.6 Authentication, recovery, devices — 🟡/⛔

- Passkey registration options + single-use 5-min challenges + consume —
  ✅ (`passkeys.rb:registration_options`, `PasskeyChallenge#consume!`).
- ⛔ `Passkeys.verify` does NOT call the `webauthn` gem: in non-production
  it issues a session token for any credential after challenge consumption;
  in production it raises. No `Authenticator` record is ever created, no
  public key stored, no sign-count checked. Account creation is
  email-only (`find_or_create_by!`) — anyone can create an account for
  any email.
- Session tokens: Bearer, 1 h, SHA-256 digest stored, revocable — ✅.
  Rate limits (passkey 10/min/IP, recovery 5/min/IP, API 300/min/IP) ✅
  in `rack_attack.rb`, but the cache store is never configured (in-memory
  default, per-process).
- Recovery: local recovery key ✅ in all three client vaults. Server
  recovery ⛔ stub: `Recovery::Challenge` returns a random hex that is
  never stored; there is no verify endpoint and no trusted-device transfer.
- Device enrol/revoke ✅ as code; revocation deletes envelopes via
  `KeyEnvelopes::Rotate` but nothing re-issues fresh envelopes (client
  work that does not exist).
- Biometrics: presence check only, honestly labelled, never unlocks — ✅
  as specified (mobile `LockScreen.tsx`). Keychain/Keystore wrap 🔴 missing.

## 4.7 Extension autofill — ✅ implemented (code, untested)

- MV3, no host permissions, on-demand content-script injection, single
  credential per fill, top-frame only, origin must match exactly — ✅
  (`background.ts:handleFill`, `content.ts`, `domain.ts`).
- Domain gate: HTTPS only (localhost excepted), no raw IPs, subdomain-or-
  exact match, punycode + bank/card need explicit confirmation, per-origin
  allow/block lists — ✅ (`domain.ts:checkFillAllowed`, `settings.ts`).
- Popup: unlock/create, per-site logins, fill, save-login offer, item
  detail + copy, generator, health, settings — ✅ (`Popup.tsx`, 24.5 KB).
- Gaps: extension vault is separate until sync; TOTP fill is not wired
  (popup shows `hasTotp` only); no auto-fill on page load (by design).
- ⚠️ `background.ts` `getItem` returns the full decrypted item to the
  popup, which holds the plaintext password in React state while open —
  accepted extension-page risk, but it means the "only one credential to
  the content script" boundary does not cover the popup.

## Cross-cutting: deployment, audit, quality — 🔴

- No production deployment validation: Compose exists, never run; cloud
  is docs only; no CI, no lockfiles (`Gemfile.lock` absent; no npm
  lockfile in the repo listing), no `bin/rails`.
- No external security audit; no fuzz/pen-test; no published KAT vectors
  (Rust tests and Node tests are round-trips only).
- `packages/ui` is an empty stub; there is no shared design system.
- Node tests re-implement the logic they claim to test (see
  `docs/implementation-status.md`); RSpec covers sync push/pull + items
  only — no auth/passkey/recovery/blob/share/device specs.
