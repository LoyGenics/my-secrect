# Architecture — as built (Phase A audit, 17 Nov 2026)

> Verified by reading the code on disk. Nothing in this repo has ever been
> built, tested, or run (no `npm install`, `tsc`, `bundle install`, `cargo test`,
> or `docker compose up` has ever executed here). Every status below is
> **code-read only**. See `docs/implementation-status.md` for the ledger.

## 1. System shape

Monorepo (npm workspaces `apps/*`, `packages/*`), branch `main`, kept as one repo.

```
my-secrect/
  apps/api        Rails 7.1 API-only, PostgreSQL, Sidekiq/Redis, S3-compatible blobs
  apps/desktop    React 18 + Vite + Tailwind, Tauri shell (incomplete, see §5)
  apps/mobile     Expo React Native 0.76 / SDK 52
  apps/extension  MV3 extension (React popup/options + TS service worker + content script)
  apps/web        Thin wrapper: imports apps/desktop/src/App, adds amber banner
  packages/core, schemas, sync, crypto-adapters, storage, import-export, ui, sdk
  native/crypto-core            Rust + sodiumoxide (libsodium), untested
  native/ios-credential-provider   EMPTY directory (no files)
  native/android-credential-provider  EMPTY directory (no files)
  native/ssh-agent              README only
  specs/  encryption-format, key-management, sync-protocol, recovery-protocol, threat-model
  tests/  Node .mjs mirrors + RSpec request/model specs
  infra/docker (Compose: Caddy + api + worker + Postgres 16 + Redis + MinIO),
  infra/self-host, infra/cloud (docs only)
```

There are **three separate local vaults**, not one: desktop/web localStorage
(`my-secrect.local-vault.v1`), extension `chrome.storage.local`
(`my-secrect.ext.vault.*.v1`), mobile AsyncStorage (same key names as desktop).
They share crypto code but no data until sync is wired (it is not — see §4).

## 2. Entry points

| App | Entry | Notes |
|---|---|---|
| desktop | `apps/desktop/src/main.tsx` → `App.tsx` (711 lines) | Vite dev port 1420; `npm run build` = `tsc && vite build` |
| web | `apps/web/src/main.tsx` → `src/App.tsx` → `../../desktop/src/App` | Vite port 5174; same App, sky-override CSS |
| mobile | `apps/mobile/index.js` (Buffer polyfill) → `src/App.tsx` | Expo; bottom tabs Vault/Search/Generate/Health/Settings |
| extension | `public/manifest.json` → `background.js`, `popup/index.html`, `options/index.html`, `content.js` | Vite multi-entry build; `tsc && vite build` |
| api | `apps/api/config.ru` → Rails API-only | Puma :3000; `/health` returns `{"ok":true}` |
| crypto-core | `native/crypto-core/src/lib.rs` | `cargo test`; unit tests in-file + `tests/vectors.rs` |

## 3. State management

No store library anywhere. Each client keeps module-level mutable state:

- Desktop/mobile/extension vaults: module-scope `masterKey`, `vaultKey`,
  `unlockedItems` (plaintext `VaultItem[]` in memory while unlocked),
  zero-filled on lock (`clearMemory`). React state in `App.tsx` mirrors it
  (`items`, `trash`, `view`, `selectedId`).
- Sync queue/checkpoints/conflicts: localStorage keys
  `my-secrect.sync.queue.v1` / `.checkpoint.v1` / `.conflicts.v1`
  (`packages/sync/src/index.ts`). Nothing in any app reads/writes them yet.
- Extension: background worker is the only key holder; popup/options talk
  via `chrome.runtime` messages (`src/lib/messages.ts`); autolock via
  `chrome.alarms` (default 5 min).
- Server: Postgres is the source of truth for ciphertext versions + sync
  sequence; no server-side cache of vault state.

## 4. Data models

Client plaintext model — `packages/core/src/types.ts`: `VaultItem`
(`id`, `type` 12 values, `schema_version: 1`, `title`, `fields` free-form,
`tags`, `relations`, `attachments` blob ids, `favorite?`, `deleted_at?`).
Field shapes per type live in `packages/schemas/src/item-types.ts` and in
`apps/desktop/src/components/ItemForm.tsx` (field tables per type).

Server model — `apps/api/db/schema.rb` (15 tables, UUID PKs): `users`,
`authenticators`, `devices`, `sessions` (SHA-256 `token_digest`), 
`passkey_challenges`, `vaults`, `key_envelopes`, `items`, `item_versions`
(unique `item_id`+`revision`), `sync_events` (unique `vault_id`+`sequence`),
`blobs`, `blob_parts`, `shares`, `device_checkpoints`, `audit_events`.
Server stores ciphertext + opaque ids only; `ItemPresenter` returns only
`id/vault_id/current_revision/deleted_at/current_version{ciphertext}`.

Sync protocol — `specs/sync-protocol.md` + `packages/sync/src/index.ts`:
append-only events, optimistic concurrency (`base_revision`, 409 on stale),
keep-both conflicts, tombstones, client-side AEAD verify before apply.
**Broken link: `Sync::Pull` (`apps/api/app/domains/sync/pull.rb:9-13`)
returns events WITHOUT `encrypted_payload`/`encrypted_item_key`, while
`applyRemoteEvents` skips payload-less events (`packages/sync/src/index.ts`,
"no ciphertext payload — cannot verify or apply"). Pull can therefore never
apply a remote change. Push works; pull is metadata-only.**

## 5. Encryption boundaries

- Client vault crypto: `packages/crypto-adapters/src/index.ts` — MAIN adapter
  is `libsodiumAdapter` (Argon2id INTERACTIVE ops 2 / mem 64 MiB, salt 16 B;
  XChaCha20-Poly1305, fresh 24 B nonce; HKDF-SHA-256 via HMAC). A
  `webCryptoReferenceAdapter` (PBKDF2 600k + AES-GCM) is kept REFERENCE ONLY.
  Key hierarchy: passphrase → KEK → Account Master Key → Vault Key →
  per-item Item Key; recovery key 32 B random, SHA-256 → recovery KEK wraps
  the Master Key. Implemented identically (modulo storage) in desktop
  `vault.ts`, mobile `vault.ts`, extension `vault-ext.ts`.
- Native crypto: `native/crypto-core` (Rust/sodiumoxide) implements the same
  shape + secretstream, **but with Argon2id SENSITIVE limits** — KEKs derived
  by Rust and by TS do not match. No bindings connect Rust to any TS app.
- Server: no decryption anywhere. Account auth (passkey) is separate from
  vault unlock. Session tokens: `sess_` + 32 random bytes hex, SHA-256 digest
  stored, 1 h TTL, revocable (`SessionTokens`).
- Media: per-file 32 B File Key, 1 MiB chunks, each XChaCha20-Poly1305 with
  fresh nonce; manifest (chunk list, sizes, SHA-256 of ciphertext) encrypted
  with the Vault Key (`packages/storage/src/upload.ts`). **Gap: the manifest
  has no field for the wrapped File Key, so no code path can recover a File
  Key on download** (`media.ts` claims otherwise — false).
- Sharing: model only (`packages/core/src/sharing.ts`, `Sharing::Create` /
  `Revoke`). No HPKE / key exchange; no recipient keypair exists anywhere.

## 6. Service dependencies

- API runtime: Postgres 16, Redis (Sidekiq + Rack::Attack), S3-compatible
  storage (MinIO locally; R2/S3 in cloud). Caddy terminates TLS.
- Clients: no backend calls at all in desktop/mobile/web/extension today —
  all four are local-only. `packages/sdk` (`VaultApiClient`) and
  `packages/sync` (`SyncClient`) exist but are imported by nothing.
- Tauri: `apps/desktop/src-tauri/` contains ONLY `tauri.conf.json` — no
  `Cargo.toml`, no `src/main.rs`. There is no buildable Tauri app.

## 7. Per-subsystem status

| Subsystem | Status | Evidence |
|---|---|---|
| Desktop vault (crypto, CRUD, trash, health, generator, TOTP, settings, export/import) | Implemented but untested | `apps/desktop/src/vault.ts` (555 lines), `App.tsx`; never built/run |
| Desktop media UI | Partially implemented (orphaned) | `MediaView.tsx` exists; zero references from `App.tsx` |
| Desktop sharing UI | Partially implemented (orphaned) | `SharesView.tsx` exists; zero references from `App.tsx`; HPKE missing |
| Mobile (10 screens, same vault crypto, biometrics presence-only) | Implemented but untested | `apps/mobile/src/*`; `LockScreen.tsx` explicitly does not unlock from biometrics |
| Extension (MV3, autofill, domain gate, on-demand content script) | Implemented but untested | `background.ts`, `content.ts`, `domain.ts`, `vault-ext.ts`, `Popup.tsx`; separate vault until sync |
| Web client | Implemented but untested | Reuses desktop App wholesale; banner claims contradicted (see security-review) |
| Rails API (models/domains/controllers/jobs) | Implemented but untested; passkey verify stubbed | `apps/api/*`; `passkeys.rb` raises in prod, issues tokens unverified otherwise |
| Sync engine (client) | Implemented but untested; unwired | `packages/sync/*`; no app imports it; server pull omits payload |
| Chunked media upload/download | Implemented but untested; incomplete | `packages/storage/src/upload.ts`; no File Key persistence; 1 MiB vs server 8 MiB parts |
| Sharing (model + API) | Partially implemented | No HPKE; `encrypted_key` may be null; share created active |
| Rust crypto-core | Implemented but untested | `lib.rs` + `vectors.rs`; SENSITIVE vs TS INTERACTIVE mismatch |
| iOS/Android credential providers | Missing | Both `native/*` dirs are EMPTY (0 files) |
| Keychain/Keystore device-key wrap | Missing | Plan-only READMEs under `apps/mobile/native/` |
| SSH agent | Scaffold only | `native/ssh-agent/README.md` only |
| SQLCipher storage | Missing | LocalStorage/AsyncStorage/chrome.storage only; seam exists |
| packages/ui (design system) | Scaffold only | `src/index.ts` is `export {};` |
| packages/import-export | Partially implemented | Format skeleton only; real export/import live in each vault.ts |
| Recovery (server) | Scaffold only / broken | Challenge issued but never stored/verified; no verify endpoint |
| Infra / deployment | Scaffold only | Compose + Caddy + docs exist; never run; no Gemfile.lock; no CI |
| Tests | Partially implemented | Node tests mirror logic instead of importing it; RSpec covers sync/items only |
| External security audit | Missing | None; every file says so |

## 8. Known cross-cutting gaps (detail in `security-review.md`)

1. Passkey crypto verification not wired (Critical).
2. Sync pull returns no ciphertext; sync unwired in all apps (Critical).
3. Web plaintext export reachable despite "encrypted-only" banner (High).
4. TS/Rust Argon2id parameter mismatch (High).
5. Sharing HPKE missing; recovery server flow is a stub (High).
6. No SQLCipher/Keychain; three separate local vaults (High).
7. Sync/device signatures never created or verified (High).
8. Blob upload: uncapped `part_count`, quota never enforced, no File Key store (High).

## 9. Audit coverage note

Files read in full: root README + package.json; all 5 `specs/`; desktop
`vault.ts`, `App.tsx`, `ItemForm/ItemDetail/SettingsView/MediaView/SharesView/
Sidebar.tsx`, `utils/media|totp|password|health.ts`, `index.css`, `tailwind.config.js`,
`package.json`; mobile `vault.ts`, `App.tsx`, `LockScreen/SettingsScreen.tsx`,
`theme.ts`, `package.json`, `index.js`, `app.json`, READMEs; web `App.tsx`,
`index.css`, README; extension `background/content/vault-ext/domain/messages/
settings.ts`, `Popup.tsx`, `manifest.json`, `vite.config.ts`, `package.json`,
README; packages `core/types|index|sharing`, `sync/index|sync-client`,
`storage/index|upload`, `crypto-adapters/index`, `import-export/index`,
`schemas/item-types`, `sdk/index`, `ui/index`; `native/crypto-core` lib/Cargo/
tests/README; API Gemfile, routes, all controllers, domains (passkeys,
session_tokens, sync push/pull, upsert/delete/item_presenter, sharing,
recovery, blobs x3 + storage_provider, devices enroll/revoke, key_envelopes
rotate, accounts register, audit, quota), models (user/session/passkey_challenge/
item/vault/sync_event), `schema.rb`, `database.yml`, `production.rb`,
`rack_attack.rb`, `cors.rb`, `webauthn.rb`, `application.rb`, `sidekiq.rb`,
Dockerfile, `.env.example`, RSpec sync/items specs + rails_helper + auth_helper;
infra Compose/Caddyfile/READMEs; all Node test files. Listed but not line-read:
remaining API models, `vaults/create.rb`, `orphan_blob_cleanup_job.rb`,
migrations, model specs/factories, `Dockerfile.api`, web tailwind config,
desktop/web vite configs, individual mobile screens other than Lock/Settings,
extension `Options.tsx`/`popup.css`.
