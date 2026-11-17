# Implementation Status — master ledger (Phase A, 17 Nov 2026)

> Every status below is from reading code on disk. **Nothing has been built,
> tested, or run on the Mac.** Statuses: ✅ Implemented & verified (none —
> verification requires running code) · 🔨 Implemented, untested · 🟡 Partial
> · 🏗️ Scaffold only · 🔴 Missing · ⛔ Broken (contradicts its contract).
> Line numbers are from the 17 Nov 2026 read.

## Ledger

### Apps

| Subsystem | Status | Evidence | Next action |
|---|---|---|---|
| Desktop vault core (create/unlock/recovery/change-passphrase/wipe, CRUD, trash, search, export/import) | 🔨 Implemented, untested | `apps/desktop/src/vault.ts` (555 lines), `App.tsx` (711) | Run `npm install && npm run build` in Terminal; add real vault tests importing `vault.ts` |
| Desktop items UI (12 types, health, generator, TOTP, settings, auto-lock, example data) | 🔨 Implemented, untested | `App.tsx` + 9 components; `utils/health|password|totp.ts` | Same as above; wire Media/Shares views or delete them |
| Desktop media view | 🟡 Partial (orphaned) | `components/MediaView.tsx`; 0 refs from `App.tsx` | Decide: wire into a `media` view with real upload/download, or remove |
| Desktop shares view | 🟡 Partial (orphaned) | `components/SharesView.tsx`; 0 refs from `App.tsx` | Wire only after HPKE lands; until then keep hidden |
| Desktop Tauri shell | 🏗️ Scaffold only | `src-tauri/` = `tauri.conf.json` only | Add `Cargo.toml` + `src/main.rs` + SQLCipher plugin, or drop Tauri claims |
| Mobile vault (same crypto, AsyncStorage) | 🔨 Implemented, untested | `apps/mobile/src/vault.ts` (257 lines) | `npm install && npx expo start`; test on device (WASM path uncertain) |
| Mobile screens (10) | 🔨 Implemented, untested | `src/screens/*.tsx` (10 files); Lock/Settings line-read | Verify navigation + each screen on device |
| Mobile biometrics | 🟡 Partial | `LockScreen.tsx`: presence check only, honestly labelled | Implement Keychain/Keystore wrap per `native/keychain-keystore/README.md` |
| Extension MV3 (background/popup/options/content) | 🔨 Implemented, untested | `background.ts`, `vault-ext.ts`, `Popup.tsx` (24.5 KB), `manifest.json` | `npm run build`, load unpacked in Chrome, test unlock + fill + wasm |
| Extension autofill + domain gate | 🔨 Implemented, untested | `domain.ts`, `content.ts`, `background.ts:handleFill` | Same Chrome test; verify wasm/asm fallback in service worker |
| Web client | 🔨 Implemented, untested; ⛔ banner claim false | `apps/web/src/App.tsx` reuses desktop App incl. plaintext export | Disable plaintext export in web (prop) or correct banner + README |
| Rails API (models/domains/controllers/jobs) | 🔨 Implemented, untested | `apps/api/*` (16 models per schema, 21 domain files) | `bundle install && db:migrate && rspec` in Terminal |
| Passkey verify | ⛔ Broken | `app/domains/authentication/passkeys.rb:38-47` | Wire `WebAuthn::Credential.from_create/from_get` + store `Authenticator` + sign-count |
| Sync (server push/pull) | ⛔ Broken (pull) | `sync/pull.rb:9-13` omits payload | Include `encrypted_payload` + `encrypted_item_key` via `current_version` in pull |
| Sync (client) | 🔨 Implemented, untested; unwired | `packages/sync/*`; no app imports it | Wire `SyncClient` into desktop/mobile after pull fix; add E2E harness |
| Blobs (presigned sessions) | 🔨 Implemented, untested; 🟡 incomplete | `app/domains/blobs/*` | Cap `part_count`, enforce quota, verify sizes on complete |
| Sharing (API + model) | 🟡 Partial | `sharing/create|revoke.rb`, `core/sharing.ts` | Implement HPKE; reject null `encrypted_key`; add recipient keys |
| Recovery (server) | 🏗️ Scaffold only | `recovery/challenge.rb` (stateless stub) | Store challenges, add verify endpoint, or remove endpoint |
| Quota/billing | 🏗️ Scaffold only | `billing/quota.rb` never called | Call from upload-session + sync push, or delete the claim |
| Jobs (orphan cleanup, quota, retention) | 🔨 Implemented, untested | `app/jobs/*` (4 files) | Schedule + verify; note quota job only logs |

### Packages

| Subsystem | Status | Evidence | Next action |
|---|---|---|---|
| `core` (types, sharing, id gen, validation) | 🔨 Implemented, untested | `src/types.ts`, `sharing.ts`, `index.ts` | Add schema validation tests (real imports) |
| `schemas` (item types) | 🔨 Implemented, untested | `src/item-types.ts` | Enforce in `upsertItem` (currently unvalidated free-form `fields`) |
| `crypto-adapters` (libsodium main + WebCrypto reference) | 🔨 Implemented, untested | `src/index.ts` (262 lines) | Add libsodium KATs; delete or gate the reference adapter in prod builds |
| `sync` (queue, conflicts, apply, client) | 🔨 Implemented, untested | `src/index.ts`, `sync-client.ts` | Rewrite Node tests to import the real modules (tsx/vitest) |
| `storage` (chunked upload/download, manifest, resumable) | 🔨 Implemented, untested; 🟡 incomplete | `src/upload.ts`; no File Key store | Add wrapped File Key to manifest; reconcile 1 MiB vs 8 MiB |
| `import-export` | 🏗️ Scaffold only | `src/index.ts` (skeleton) | Move real export/import here or delete the package |
| `ui` | 🏗️ Scaffold only | `src/index.ts` = `export {};` | Build token + component package (see design-system.md) |
| `sdk` (`VaultApiClient`) | 🔨 Implemented, untested; unwired | `src/index.ts` (16 lines) | Wire into apps after pull fix; add token refresh + error mapping |

### Native / infra / tests / docs

| Subsystem | Status | Evidence | Next action |
|---|---|---|---|
| `crypto-core` (Rust) | 🔨 Implemented, untested | `src/lib.rs` (5 unit tests) + `tests/vectors.rs` | `cargo test`; align Argon2id params with TS; add KATs; build WASM bindings |
| iOS credential provider | 🔴 Missing | `native/ios-credential-provider/` EMPTY (0 files) | Native Xcode work (Phase C+) |
| Android credential provider | 🔴 Missing | `native/android-credential-provider/` EMPTY (0 files) | Native Android work (Phase C+) |
| SSH agent | 🏗️ Scaffold only | `native/ssh-agent/README.md` only | Decide scope or remove |
| SQLCipher storage | 🔴 Missing | Seam exists (`StorageBackend`); localStorage/AsyncStorage only | Implement per platform |
| Infra docker (Caddy+api+worker+PG+Redis+MinIO) | 🏗️ Scaffold only | `infra/docker/*`; never run | `docker compose up --build`, migrate, health check |
| Infra cloud/self-host | 🏗️ Docs only | `infra/cloud|self-host/README.md` | Validate against a real deployment |
| Node tests (8 files) | 🟡 Partial; ⛔ mirrors, not tests | All `.mjs` tests re-implement logic in-file | Rewrite to import real TS (tsx/vitest) + libsodium vectors |
| RSpec (sync/items/models) | 🟡 Partial | `spec/requests/api/v1/*`, `spec/models/*` | Add auth/passkey/recovery/blob/share/device specs; run |
| Specs (`specs/*.md`) | 🔨 Written; drift noted | 5 files | Fix sync-protocol "signed events" + secretstream claims to match code |
| Root README | 🟡 Stale in 3 bullets (fixed this audit) | See § "README fixes" | Fix remaining stale app READMEs in Phase B |
| External security audit | 🔴 Missing | None | Commission after Critical/High are fixed |

## Ranked release blockers

### Critical

1. **Passkey verification not wired** — `apps/api/app/domains/authentication/passkeys.rb:38-47`.
   Non-prod issues tokens without any crypto check; prod raises; no
   authenticator records. *Fix: wire the `webauthn` gem, persist
   `Authenticator` (credential_id, public_key, sign_count), verify
   attestation + assertion, check sign-count.*
2. **Nothing verified + no audit** — no build/test run ever; no KATs; no
   external review. *Fix: run the verification commands below, then audit.*

### High

3. **Sync pull returns no ciphertext; sync unwired** — `sync/pull.rb:9-13`,
   `packages/sync/src/index.ts`, no app imports `SyncClient`.
4. **Web plaintext export contradicts its banner** — `apps/web/src/App.tsx`,
   `apps/desktop/src/App.tsx:616-618`, `SettingsView.tsx:195-222`.
5. **Argon2id TS/Rust parameter split** — `crypto-adapters/src/index.ts`
   (INTERACTIVE) vs `native/crypto-core/src/lib.rs` (SENSITIVE).
6. **Sharing has no key exchange** — `sharing/create.rb:9-14` accepts null
   `encrypted_key`; no HPKE; no recipient keys.
7. **Server recovery is a stub** — `recovery/challenge.rb` (stateless),
   no verify endpoint.
8. **Local storage unencrypted at rest; 3 separate vaults** — desktop
   localStorage, mobile AsyncStorage, extension chrome.storage; no
   SQLCipher/Keychain; `createVault` overwrites without guard.
9. **Sync signatures never created/verified** — `sync/push.rb`,
   `encrypted_records/upsert.rb` (signature dropped).
10. **Blob abuse + undecryptable downloads** — `blobs/upload_session.rb`
    (uncapped `part_count`, no quota), `complete.rb` (no size check),
    `storage/src/upload.ts` (no wrapped File Key in manifest).

### Medium

11. Sync `sequence` race (max+1, no lock) — `upsert.rb:21-22`, `delete.rb:13`.
12. Rack::Attack cache store never configured — `rack_attack.rb`.
13. S3/DB defaults in code (`minio`/`minio123`, `POSTGRES_PASSWORD ''`).
14. Tauri origin missing from CORS defaults — `cors.rb`.
15. Node tests mirror logic instead of importing it — `tests/**/*.test.mjs`.
16. No CSP/headers for the web client.
17. `toggleFavorite` fire-and-forget; plaintext export unaudited.
18. Stale docs/comments (desktop README, web README, crypto-core README,
    mobile README/index.js, `ApplicationController` token comment,
    `password.ts` type comment, sync-protocol spec).

### Low

19. Password-generator modulo bias (desktop + extension).
20. TOTP SHA-1/6-digit only.
21. Health-score rules differ desktop vs extension.
22. `ItemForm` card `last4` uses `autoComplete="cc-number"`.
23. Deprecated `infra/docker/Dockerfile.api` still ships; no lockfiles.

## README fixes made in this audit (root `README.md` only)

- Extension autofill bullet: was "Không có browser extension autofill —
  chỉ có README + quy tắc tách privilege" → corrected: autofill IS
  implemented (`background.ts` fill, `domain.ts` gate, on-demand content
  script, MV3, no host permissions), untested, separate vault until sync.
- Crypto bullet: was "Crypto TypeScript vẫn là reference (WebCrypto
  AES-GCM/PBKDF2), chưa thay bằng bindings tới native/crypto-core" →
  corrected: the main TS adapter IS libsodium (Argon2id +
  XChaCha20-Poly1305); WebCrypto is reference-only; Rust bindings still
  not wired and Argon2id params differ (TS INTERACTIVE vs Rust SENSITIVE).
- Credential-provider bullet: was "chỉ có README trong
  `native/ios-credential-provider/` và `native/android-credential-provider/`"
  → corrected: both directories are EMPTY (no files at all); only the
  mobile `native/*` plan READMEs exist.
- No other README changes. Known-stale app READMEs (desktop "No autofill",
  "libsodium reference adapter"; web "Export is encrypted-only"; mobile
  Buffer claim; crypto-core README "REAL crypto lives here, NOT in
  crypto-adapters") are recorded as findings for Phase B, not edited here.

## Verification commands the user must run in Terminal (nothing ran here)

```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect
npm install && npm test                       # Node tests (mirrors only — see §Medium 15)
cd apps/desktop && npm install && npm run build   # tsc + vite build
cd ../web && npm install && npm run build
cd ../extension && npm install && npm run build   # then load dist/ unpacked in Chrome
cd ../mobile && npm install && npx tsc --noEmit && npx expo start
cd ../api && cp .env.example .env   # fill secrets
bundle install && bundle exec rails db:create db:migrate && bundle exec rspec
cd ../../native/crypto-core && cargo test
cd ../../infra/docker && cp .env.example .env   # fill secrets, set domain in Caddyfile
docker compose up --build -d && docker compose exec api bundle exec rails db:migrate
curl -fsS http://localhost:3000/health
```

Also: `git status` in the repo root to confirm only `docs/` + `README.md`
changed in this audit (no code was touched).
