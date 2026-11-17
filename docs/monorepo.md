# Monorepo — why one repo, and how to keep it tidy

> Decision (17 Nov 2026, confirmed by the owner): **keep the monorepo**.
> Do not split one repo per app. This document records why, and the rules
> that keep the single repo from turning into a mess.
>
> Status note: nothing in this repo has ever been built, tested, or run on
> the Mac. Statuses below are code-read only — see
> `docs/implementation-status.md`.

## 1. Why a monorepo

All five apps share one thing that must never drift apart: **the crypto
and the vault schema**.

- One Argon2id profile, one key hierarchy, one envelope format
  (`packages/crypto-adapters`, `specs/key-management.md`,
  `specs/encryption-format.md`). A split already happened once — TS used
  Argon2id INTERACTIVE while Rust used SENSITIVE, producing incompatible
  KEKs — and unifying it took a dedicated fix plus shared test vectors.
  Five separate repos would make that drift the default state.
- One `VaultItem` model and one schema version (`packages/core`,
  `packages/schemas`). A new item field added in desktop must be readable
  by mobile and the extension on the same day, not after five version bumps.
- One sync protocol (`packages/sync`, `specs/sync-protocol.md`) — a
  conflict-resolution change must land in every client atomically, or two
  devices will disagree about who wins.
- One person maintains it. Five repos means five sets of CI, five lockfiles,
  five release tags, and publishing shared packages to npm just to use your
  own code.

Split only if one of these becomes true: separate teams per app with
independent release cycles, different access control per app, or one app
outgrowing the repo (e.g. a native app needing its own Xcode/Android
project lifecycle). None of those is true today.

## 2. The tree — what lives where

```
my-secrect/
  apps/api        Rails API-only. Server sees ciphertext + opaque ids only.
                  No TypeScript package is used here.
  apps/desktop    React + Vite + Tailwind. The vault UI every other client
                  reuses or mirrors. Tauri shell in src-tauri/.
  apps/mobile     Expo React Native. Same vault crypto as desktop, storage
                  is AsyncStorage. Native plans live in native/ (READMEs).
  apps/extension  MV3 extension. Background worker is the ONLY key holder;
                  popup/options never import the vault. Separate vault
                  (chrome.storage.local) until sync lands.
  apps/web        Thin mirror: imports ../../desktop/src/App, adds an amber
                  banner + responsive shell. NO screens of its own.
                  Plaintext export is forced OFF here (allowPlaintextExport={false}).
  packages/core        VaultItem model, sharing model, id gen, validation.
  packages/schemas     Item types, SCHEMA_VERSION, FORBIDDEN_FIELDS (no CVV/PIN/live OTP).
  packages/sync        Offline queue, SyncClient, keep-both conflicts, tombstones.
  packages/crypto-adapters  libsodiumAdapter (REAL) + webCryptoReferenceAdapter (REFERENCE ONLY).
  packages/storage     Chunked encrypted upload/download, encrypted manifest, resumable.
  packages/import-export    Encrypted export v1, CSV import (Bitwarden/1Password).
  packages/ui        My Secret Design System: tokens (--ms-*), Radix components.
  packages/i18n      EN + VI dictionaries, type-checked against each other.
  packages/sdk       VaultApiClient (typed sync/blob). Exists; no app uses it yet.
  native/crypto-core Rust + libsodium. No bindings connect it to any TS app yet.
  native/ios-credential-provider     Swift: real domain matching + Keychain code;
                                     credential fill NOT implemented (fatalError).
  native/android-credential-provider Kotlin: real domain matching + Keystore code;
                                     credential fill NOT implemented (fail-closed).
  native/ssh-agent   Rust: real agent wire protocol; holds no keys, cannot sign.
  specs/   Protocol specs. Change the spec in the same commit as the code.
  tests/   Plain-Node .mjs tests. They MIRROR the rules — they do not import
           the real TS modules (needs vitest/ts-node). A green run proves the
           rules, not the production code. Say so when reporting results.
  infra/docker   Compose: Caddy + api + worker + Postgres + Redis + MinIO.
  infra/self-host, infra/cloud   Docs only, never validated by running.
  docs/    Architecture, status ledger, security review, design system,
           requirements, deployment, store prep, privacy, this file.
  .github/workflows/  ci.yml + security.yml. Written, NEVER RUN (no lockfiles yet).
```

## 3. Where new code goes

| New code is… | Put it in |
|---|---|
| A screen / flow for one app only | That app's `src/` (e.g. `apps/desktop/src/components/`) |
| Logic two or more apps need | The right `packages/*` — never copy-paste it into each app |
| A new vault item type / field | `packages/schemas` (version it) + `packages/core` if the model changes |
| Crypto of any kind | `packages/crypto-adapters` (TS) or `native/crypto-core` (Rust) — and update `tests/crypto-vectors/` in the same change |
| Sync / conflict behaviour | `packages/sync` + `specs/sync-protocol.md` in the same change |
| A design token / shared component | `packages/ui` (+ `packages/i18n` for its strings) |
| A UI string | `packages/i18n` (`en.ts` + `vi.ts`) — never hardcode strings in components |
| Server behaviour | `apps/api` (domain → controller → spec, in that order) |
| Native platform code | `native/*` (real code) or `apps/mobile/native/*` (plans only, clearly labelled) |
| A doc about a decision | `docs/`; a protocol change goes in `specs/` |
| A test for a rule | `tests/<area>/` (Node mirror) or the app's own spec; say which kind it is |

## 4. The import rule (read this before touching an import)

Apps do **not** depend on packages through `package.json` today — no app
declares `@my-secrect/*` workspace dependencies (the only declared
workspace dep in the repo is `packages/ui` → `@my-secrect/i18n`).
Apps import packages by **relative path from the importing file**. The
depth depends on where the file sits:

| File location | Correct prefix | Example |
|---|---|---|
| `apps/<app>/src/*.ts(x)` — desktop, web | `../../../packages/...` | `apps/desktop/src/vault.ts` |
| `apps/mobile/src/*.ts(x)` | `../../../packages/...` | `apps/mobile/src/vault.ts` |
| `apps/<app>/src/<sub>/*.ts(x)` (one level deeper) | `../../../../packages/...` | `apps/extension/src/lib/vault-ext.ts` |
| `apps/web/src/App.tsx` → desktop | `../../desktop/src/App` | (web has no packages of its own) |

**Live example of getting it wrong:** `apps/mobile/src/App.tsx` imports
`'../../packages/core/src/types'` — from `apps/mobile/src/` that resolves
to `apps/packages/`, which does not exist. The correct depth is
`'../../../packages/core/src/types'`, exactly as `apps/mobile/src/vault.ts`
(in the same directory) already does. That import is broken today and is
the first thing to fix before any build will pass (see root README §
“Chạy thử”).

Rules:
- Count the `../` from the file, not from the app root. When in doubt,
  copy the prefix from a neighbouring file that already works.
- Never import a package by bare name (`@my-secrect/core`) unless you
  also add it to that app's `package.json` — an undeclared bare import
  will fail at build time.
- Never import `apps/*` code from `packages/*` — packages must not depend
  on apps. Never import one app from another, except web → desktop App
  (that single exception is the whole web client).
- Never import a vault file (`vault.ts`, `vault-ext.ts`) from a UI
  component that should not hold keys — extension popup/options talk to
  the background via messages, never via import.

## 5. What NOT to put where

- **No secrets, ever:** no `.env`, no `RAILS_MASTER_KEY`, no real
  credentials, no recovery keys, no vault data — in any folder. `.env`
  files are gitignored; `.env.example` files contain placeholders only.
  CI has a gitleaks job for this reason.
- **No generated output:** no `node_modules/`, `dist/`, `target/`,
  `*.lock` is the opposite — lockfiles (`package-lock.json`,
  `apps/api/Gemfile.lock`) are REQUIRED and currently missing; generate
  and commit them before claiming a reproducible build.
- **No app code in `packages/`:** packages hold shared logic only. If
  it renders a desktop-only screen, it belongs in `apps/desktop`.
- **No DOM assumptions in `packages/ui` components for mobile:** React
  Native consumes tokens only (`packages/ui` description says so).
- **No crypto in `specs/`:** specs describe the protocol; implementations
  live in code. If code and spec disagree, the code is what ships — fix
  the spec in the same change, don't leave them drifting.
- **No “temporary” files in the repo root:** scratch notes, screenshots,
  and one-off scripts belong in `/tmp`, not in git.

## 6. Tidy rules going forward

1. **One source of truth per fact.** The root README states status;
   `docs/implementation-status.md` is the ledger; app READMEs describe
   their own app. If a fact changes, update all three places in the same
   change — stale READMEs are how this repo ended up claiming extension
   autofill and libsodium crypto were “missing” after they had been built.
2. **Fix or delete, don't orphan.** A view/component nobody renders
   (`MediaView`/`SharesView` were orphaned for a whole phase) gets wired
   in or removed in the same change that creates it.
3. **A package nobody imports is a TODO, not a feature.** `sync`, `sdk`,
   `storage`, `ui`, `i18n` all exist while no app imports them. The root
   README says so plainly; don't present them as “done” until wired.
4. **Skeletons say so on the tin.** Anything not implemented (iOS/Android
   fill, SSH signing, HPKE sharing, SQLCipher) must fail closed or be
   labelled NOT implemented where it sits — never a button that pretends.
5. **Delete only with evidence.** See §7 — candidates are listed, not
   deleted, until someone confirms nothing references them.
6. **Keep the tree shallow.** A new top-level folder needs a reason in
   this file. A new app needs a reason in the root README.

## 7. Candidates for removal (LISTED ONLY — nothing was deleted)

| Candidate | Evidence | Before deleting, check |
|---|---|---|
| `infra/docker/Dockerfile.api` (266 B) | `infra/docker/docker-compose.yml` builds the api from `../../apps/api` with `dockerfile: Dockerfile` — the compose file never references `Dockerfile.api`. The Phase A audit also flagged it as deprecated. | Grep the repo for `Dockerfile.api`; confirm `apps/api/Dockerfile` is the live one; then delete. |
| Stale claims inside app READMEs (`apps/desktop/README.md`, `apps/web/README.md`, `apps/mobile/README.md`, `native/crypto-core/README.md`) | Phase A audit §18 recorded them as contradicting the code (e.g. desktop “No autofill”, crypto-core “REAL crypto lives here, NOT in crypto-adapters”). Not re-verified line-by-line in this tidy pass. | Read each README, fix the wrong bullets in place. Prefer fixing over deleting — the READMEs are otherwise useful. |
| `apps/mobile/native/*` plan READMEs vs `native/*` real code | `apps/mobile/native/` holds three plan-only READMEs (keychain-keystore, ios-credential-provider, android-credential-manager) while `native/ios-credential-provider/` and `native/android-credential-provider/` now hold real Swift/Kotlin. Two homes for the same topic. | Decide one home for native plans (suggest `native/*` READMEs), then fold or delete the duplicates — don't keep both. |
| Root has no `package-lock.json` / `apps/api/Gemfile.lock` | Not dead files — the opposite: missing files. CI's lockfiles job will fail until they exist. | Run `npm install` and `cd apps/api && bundle lock` on the Mac, commit the results. |

## 8. Known rough edges (not fixed here — tidy pass only)

- `apps/mobile/src/App.tsx` has the broken `'../../packages/...'` import
  (§4). It is the single known-broken import in the repo; fix it before
  the first build.
- `apps/web` reuses desktop CSS classes (`.btn`, `.label`, …) from
  `apps/desktop/src/index.css` via the shared App; the web sky/indigo
  drift was fixed, but the shared-class dependency is implicit — a
  desktop CSS rename silently breaks web styling.
- `packages/ui`/`packages/i18n` are not yet imported by any app, and no
  app declares workspace deps — the migration path is documented in
  `packages/ui/README.md`; until it lands, the design system is a
  package, not the UI.
