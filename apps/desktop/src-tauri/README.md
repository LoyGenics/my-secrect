# my-secrect — Tauri desktop shell (`src-tauri/`)

Minimal Tauri v2 scaffold for the existing React app in `apps/desktop/src/`
(Vite dev server on port 1420, production build output `apps/desktop/dist/`).

## Status — scaffold only, NEVER built

- **Nothing here has ever been compiled, run, or bundled on the Mac.** No
  `cargo tauri dev`, no `cargo tauri build`, no `npm run tauri build` has
  executed. The scaffold is written to be minimal and buildable *in
  principle*; the first build is the real verification step.
- **Storage is still the localStorage prototype** (`apps/desktop/src/vault.ts`).
  This shell changes nothing about storage yet. The `StorageBackend`
  seam in `vault.ts` is where SQLCipher plugs in later.
- **No Keychain integration, no auto-updater, no plugins.** See below.

## Files

```
Cargo.toml               Tauri v2 only (tauri-build as build dependency)
build.rs                 tauri_build::build()
src/main.rs              Window + 3 read-only commands (paths/version only)
tauri.conf.json          App id, window, CSP, bundle config
capabilities/default.json  core:default only — no fs/shell/http access
icons/                   GENERATED — see "Icons" (does not exist yet)
```

## Prerequisites (run once, in Terminal on the Mac)

```sh
# Rust toolchain (Tauri v2 needs Rust 1.77+)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustc --version   # check it prints 1.77 or newer

# Xcode command-line tools (linker + macOS SDK)
xcode-select --install
```

## Icons (REQUIRED before the first bundle build)

`tauri.conf.json` points `bundle.icon` at `icons/` — that folder does not
 exist yet, and `cargo tauri build` will fail without it. Generate it from
 a 1024×1024 PNG (any square padlock source, e.g. the extension icon
 upscaled, or a fresh export):

```sh
cd apps/desktop
npx @tauri-apps/cli icon path/to/icon-1024.png
# verifies: ls src-tauri/icons   (expect icon.icns, icon.ico, 32x32.png, 128x128.png, 128x128@2x.png)
```

`@tauri-apps/cli` is already a devDependency of `apps/desktop`.

## Build / run (Terminal on the Mac)

```sh
cd apps/desktop
npm install

# Dev: Vite on http://localhost:1420 inside the Tauri window
npx tauri dev

# Production bundle (.dmg / .app under src-tauri/target/release/bundle/)
npx tauri build
# equivalent: cargo tauri build
```

Expected first-build outcomes to check: the window opens at 1100×720, the
React app loads, and `npx tauri build` produces a signed/unsigned `.app`
(`src-tauri/target/release/bundle/macos/`). macOS code signing / notarisation
is NOT configured — an unsigned local build will trigger Gatekeeper on
first launch on another Mac (`Right-click → Open` to run it).

## Commands exposed to the frontend (`src/main.rs`)

| Command | What it does |
|---|---|
| `app_version()` | Returns the Cargo package version. |
| `vault_data_dir()` | Returns the OS app-data directory path. |
| `vault_database_path()` | Returns the agreed future SQLCipher path (`<app-data>/vault.db`). It does NOT create, open, or migrate anything. |

No command accepts or returns a passphrase, key, or vault item. The
frontend (`apps/desktop/src/`) does not call these commands yet — they are
hooks for the storage migration.

## Window + security config (`tauri.conf.json`)

- Identifier `com.loygenics.my-secrect`, window 1100×720 (min 900×600),
  centred, resizable, not fullscreen.
- CSP: `default-src 'self'` with `img-src 'self' data: blob:`, inline
  styles allowed (Tailwind/React inline styles need it), scripts `'self'`
  only, `connect-src` limited to self + the Vite dev server
  (`http://localhost:1420`, `ws://localhost:1420` for HMR). The localhost
  entries only matter in dev; tighten them out if the prod CSP is ever
  split from the dev one.
- Capabilities: `core:default` only. No `fs`, `shell`, `dialog`, `http`, or
  `notification` plugin is installed or permitted.

## Updater — NOT configured (deliberate)

There is **no auto-update mechanism** in this scaffold: no
`tauri-plugin-updater` dependency, no signing key, no update endpoint, and
no `plugins.updater` section in `tauri.conf.json`. Shipping an updater
with a placeholder endpoint or an unsigned keypair would be worse than
none. To add it later: generate an updater keypair
(`npx @tauri-apps/cli signer generate`), add `tauri-plugin-updater` +
its `pubkey`/`endpoints` to the config, host a signed update feed
(`latest.json`), and test the update on a staging build first.

## SQLCipher migration — still TODO (the real Phase F gap)

1. Add a Tauri SQLCipher plugin/command layer (or a Rust `sqlcipher`
   binding) exposing open/close/read/write of encrypted rows at
   `vault_database_path()`.
2. Implement the `StorageBackend` interface in `apps/desktop/src/vault.ts`
   against those commands (same key hierarchy, same row format —
   `my-secrect.local-vault.v1` keys/rows move verbatim into SQLite).
3. Migrate: on first launch with the new backend, read the localStorage
   rows, write them into SQLCipher, verify a decrypt round-trip, then
   delete the localStorage copy. Keep a backup until the user confirms.
4. Key handling: the SQLCipher passphrase must be derived from the vault
   KEK / a Keychain-stored random key — never hardcode it, never store it
   next to the database in plaintext.

Until that lands, do not present the desktop app as having hardened
storage: it is a localStorage prototype inside a native window.

## What was decided in Phase F (ambiguities, safest choice taken)

- Tauri v2 (not v1): v1 is maintenance-only; the repo already lists
  `@tauri-apps/cli ^2.0.0`.
- No plugins enabled: least privilege until a feature needs one.
- Updater left out entirely rather than half-configured (see above).
- Icons are generated by the CLI from a source PNG instead of committing
  hand-made `.icns`/`.ico` files that may not match the bundle layout.
- `vault.db` under the OS app-data dir (Tauri default location) rather
  than next to the binary — survives app updates, standard macOS layout.
