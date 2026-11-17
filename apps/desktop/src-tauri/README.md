# my-secrect — Tauri desktop shell (`src-tauri/`)

Tauri v2 shell for the React app in `apps/desktop/src/` (Vite dev server on
port 1420, production build output `apps/desktop/dist/`). In this shell the
vault is stored in an **SQLCipher database whose random key lives in the OS
credential store**. The web client (`apps/web`) runs the same React code
and still uses localStorage.

## Status (18 Nov 2026)

Built and run on macOS (Apple Silicon, Xcode 26.6, Rust 1.98,
`tauri` 2.12.6). What was verified there:

- `npx tauri build --debug --bundles app` produces
  `target/debug/bundle/macos/my-secrect.app`. Launching it creates
  `~/Library/Application Support/com.loygenics.my-secrect/vault.db` (dir
  `0700`, file `0600`, no `SQLite format 3` header) and one Keychain item
  (`com.loygenics.my-secrect` / `vault-db-key`). A second launch reopens the
  same file with the same key, without errors.
- The UI-driven e2e (`tests/e2e_app.rs`, below) passes: create a vault
  through onboarding, restart, unlock, items shown; migrate a localStorage
  vault, restart, unlock; key missing → the app refuses to start.
- **Not verified:** Windows and Linux (they compile in principle, see
  "Platforms"), code signing / notarisation, the updater (none).

Crypto is still the unaudited libsodium prototype — see
`apps/desktop/README.md`. This shell hardens *storage*, not the crypto.

## How storage works

```
React (vault.ts) ──StorageBackend (sync)──> src/storage/TauriSqlcipherBackend
                                              │ write-behind cache
          startup, once: sync XHR GET vaultkv://localhost/snapshot
          after that:    invoke kv_snapshot / kv_commit
                                              ▼
src-tauri/src/lib.rs ──> store.rs (SQLCipher, vault.db) ──key──> keychain.rs (OS credential store)
```

- **Database:** `<app-data>/vault.db`, SQLCipher 4 (rusqlite
  `bundled-sqlcipher-vendored-openssl`, so no system OpenSSL is needed).
  One table `kv(key, value)` with the same strings the vault used to keep in
  localStorage (encrypted rows + wrapped keys), plus a `generation`
  counter. The whole file is encrypted, so item counts, revisions, sizes and
  key names are no longer readable on disk.
- **Database key:** 32 random bytes from the OS CSPRNG, created on first
  launch, stored only in the OS credential store, and passed to SQLCipher as
  a raw key (`sqlite3_key_v2`, zeroed buffers). It is never written next to
  the database, never sent to the webview, never logged.
- **Key policy (fail closed):** key present → open; no key and no (or an
  empty) database → create the key, read it back, create the database;
  **no key but `vault.db` has data → refuse** (a new key would orphan the
  vault; nothing is deleted); credential store locked / denied / missing →
  refuse. A refusal shows a full-window error in the app and nothing falls
  back to localStorage.
- **Atomic writes:** every `setItem`/`removeItem` made in the same JS task
  is sent as one `kv_commit` batch and applied in one SQLite transaction
  (all or nothing). Each batch carries the generation it was based on; a
  stale writer (second instance, reloaded page) is rejected instead of
  overwriting newer data. A failed write shows the same full-window error.
- **Migration:** on the first Tauri launch, the vault's two localStorage
  keys are copied into SQLCipher in one batch, read back from the database
  and compared byte for byte, and only then removed from localStorage. On
  any failure localStorage is left untouched and the next launch retries. If
  the database already holds a *different* vault, nothing is copied or
  deleted (logged as a conflict). Code: `apps/desktop/src/storage/`.

### IPC surface — the only things the webview can reach

| What | Purpose |
|---|---|
| command `kv_snapshot` | every stored pair + generation (used to verify the migration) |
| command `kv_commit(expectedGeneration, ops)` | atomic batch of `set`/`remove`, compare-and-swap on the generation |
| protocol `vaultkv://localhost/snapshot` (`http://vaultkv.localhost/…` on Windows) | the same snapshot, readable by a **synchronous** XHR |

Why a protocol: the vault's storage contract is synchronous and
`hasVault()` runs during the first React render, but Tauri commands are
async-only. The handler is read-only, `GET /snapshot` only, answers only the
`main` webview and only the app's own origins (`tauri://localhost`,
`http(s)://tauri.localhost`, and the dev server origin in debug builds).

`build.rs` declares an app ACL manifest, so **every** command is checked
against `capabilities/default.json`, which grants exactly
`allow-kv-snapshot` and `allow-kv-commit` — no `core:default`, no fs,
shell, dialog, http or notification plugin. The e2e confirms that
`plugin:app|version`, `plugin:window|title` and the removed
`vault_database_path` command are rejected.

## Files

```
Cargo.toml                 tauri 2, rusqlite (SQLCipher), keyring 4, getrandom, zeroize
build.rs                   tauri-build + app ACL manifest (kv_snapshot, kv_commit)
src/main.rs                calls my_secrect_lib::run()
src/lib.rs                 commands, vaultkv:// protocol, window creation, setup
src/store.rs               SQLCipher key/value store + unit tests
src/keychain.rs            key creation/lookup policy + Keychain tests (ignored by default)
tests/e2e_app.rs           UI-driven restart/migration e2e (opt-in)
tests/e2e_driver.js        the page-side driver for it
tauri.conf.json            app id, window (`create: false`, built in setup), CSP, bundle
capabilities/default.json  allow-kv-snapshot + allow-kv-commit only
icons/                     generated with `npx tauri icon` (from the extension icon)
```

## Build / run (Terminal on the Mac)

Prerequisites: Rust ≥ 1.90 and the Xcode command-line tools. The first build
compiles OpenSSL and SQLCipher from source (a few minutes; needs `perl` and
`make`, both present on macOS).

```sh
npm ci                                   # repo root
cd apps/desktop
npx tauri build --debug --bundles app    # → src-tauri/target/debug/bundle/macos/my-secrect.app
open src-tauri/target/debug/bundle/macos/my-secrect.app
npx tauri build                          # release .app/.dmg under target/release/bundle/
npx tauri dev                            # Vite on :1420 inside the window
```

macOS signing/notarisation is NOT configured: the build is ad-hoc signed.
Two consequences:

- Gatekeeper warns on other Macs (`Right-click → Open`).
- The Keychain item's access list trusts the binary that created it, and an
  ad-hoc signature changes with every build. Expect (not exercised in the
  runs above, which launched one build) a Keychain prompt on the first launch
  after a rebuild ("my-secrect wants to use your confidential
  information…"). Choose *Always Allow*. *Deny* makes the app stop with the
  storage error — the fail-closed path, not a bug. A stable signing
  identity avoids the prompt.

## Tests

```sh
cd apps/desktop/src-tauri
cargo test                                   # store: open/reopen, wrong key, ciphertext on disk,
                                             # atomic batch, stale generation, migration batch, schema
cargo test --lib keychain -- --ignored       # real login Keychain, random test service, cleaned up
npm --workspace apps/desktop run build       # (from the repo root) dist/ for the e2e
MY_SECRECT_E2E=1 cargo test --features custom-protocol --test e2e_app
```

The e2e opens real windows, uses a temporary data directory and a random
Keychain service per run (deleted at the end), and never touches the real
`vault.db`. It needs `apps/desktop/src/vault.ts` to use
`selectStorageBackend` (the `integration(vault)` commit). TS side:
`npx tsx --test apps/desktop/storage-backend.test.ts`.

## Platforms

| | Credential store | Status |
|---|---|---|
| macOS | login Keychain (generic password) via `keyring` | verified (above) |
| Windows | Credential Manager via `keyring` | not built or run; the sync XHR to a custom scheme on WebView2 is unverified |
| Linux / BSD | Secret Service over D-Bus (GNOME Keyring, KWallet) via `keyring` | not built or run. Without a running, unlocked Secret Service (headless, minimal WMs) the app refuses to start — by design, there is no plaintext or in-memory fallback. Sync XHR on WebKitGTK unverified |

## Window + security config (`tauri.conf.json`)

- Identifier `com.loygenics.my-secrect`; window `main` 1100×720 (min
  900×600). `create: false`: `lib.rs` builds it in `setup` after the store
  is opened.
- CSP: `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`;
  `connect-src` adds `vaultkv:` / `http(s)://vaultkv.localhost` (snapshot)
  and the Vite dev server (dev only).
- **`'wasm-unsafe-eval'` is required.** Without it WebKit refuses to compile
  libsodium's WebAssembly, libsodium silently falls back to its asm.js
  build, and that build returned stale heap bytes as "random" output in the
  webview: the recovery key was the passphrase bytes and no vault decrypted
  after a restart. It allows WebAssembly compilation only, not JS `eval`.
  The browser extension's CSP already has it. The e2e guards against this.

## Troubleshooting

- *"vault.db exists but its key … is missing from the OS credential store"*
  — the Keychain item was deleted (or the app runs under another user).
  Restore the item from a Keychain backup. To start over with an empty vault
  instead, quit the app and move `vault.db` out of
  `~/Library/Application Support/com.loygenics.my-secrect/` (the old vault
  stays unreadable without its key).
- *"…could not be opened with the key…"* — the key does not match the file
  (file replaced or corrupted). Nothing was changed; restore the file.
- *"write rejected: the vault changed elsewhere"* — a second app instance
  wrote first. Quit the other instance and restart.

## Updater — NOT configured (deliberate)

There is **no auto-update mechanism**: no `tauri-plugin-updater`, no signing
key, no update endpoint. Shipping an updater with a placeholder endpoint or an
unsigned keypair would be worse than none. To add it later: generate an
updater keypair (`npx @tauri-apps/cli signer generate`), add
`tauri-plugin-updater` + its `pubkey`/`endpoints`, grant only its permission,
host a signed `latest.json`, and test on a staging build first.
