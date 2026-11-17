# my-secrect — desktop app (Tauri + React + Vite)

Local-first Personal Digital Vault prototype. No server, no sync yet.

## Run

```bash
cd apps/desktop
npm install
npm run dev      # Vite dev server (http://localhost:1420)
npm run build    # tsc + vite build
npm run preview  # preview the production build
```

Tauri shell lives in `src-tauri/`; `npm run dev` above runs the web UI only
(localStorage storage). The desktop app (SQLCipher storage) is built with
`@tauri-apps/cli`:

```bash
cd apps/desktop
npx tauri build --debug --bundles app   # src-tauri/target/debug/bundle/macos/my-secrect.app
npx tauri dev                           # dev server inside the Tauri window
npx tsx --test storage-backend.test.ts  # storage selection + migration tests
```

Details, tests and platform status: `src-tauri/README.md`.

## What works locally

- **Create / unlock / lock a vault** — passphrase → Argon2id KEK → wrapped
  master key → wrapped vault key → per-item XChaCha20-Poly1305 encryption
  (`src/vault.ts`, crypto in `packages/crypto-adapters`). Keys live in memory
  only and are cleared on lock.
- **Items** — create, view, edit, search (Cmd/Ctrl+K palette), favourite,
  soft-delete to Trash with restore, permanent delete, across 12 item types
  grouped into 8 sidebar categories (Credentials, Finance, Identity,
  Developer, Secure Notes, Private Media, Documents, Collections) plus tags.
- **Security Health (Watchtower)** — overall score, weak-password list and
  reused-password groups, with a Fix button that opens the item for editing
  (`src/components/HealthView.tsx`, scoring in `src/utils/health.ts`).
- **Password generator** — header panel; generated passwords are copied to
  the clipboard.
- **Auto-lock** — 1 / 5 / 15 minutes or Never (default 5); the timer resets
  on pointer/key activity while unlocked.
- **Encrypted backup** — Export downloads `exportEncrypted()` output
  (VaultExport v1: encrypted rows only, no plaintext, trash excluded) as
  JSON; Import merges it back into the unlocked vault by id/revision.
- **Onboarding** — 3 steps: create a passphrase (strength meter), the
  one-time recovery key (shown once, with a confirm checkbox), then done.
  The lock screen also offers unlock with the recovery key.

## Honest limits (read before trusting this with real secrets)

- **Crypto is the libsodium reference adapter (Argon2id + XChaCha20-Poly1305).
  It is NOT audited and this app is NOT production-ready.**
- **Storage depends on where the app runs** (`src/storage/`, chosen by
  `selectStorageBackend()` in `vault.ts`):
  - **Tauri desktop app:** SQLCipher database in the app-data folder; its
    random 256-bit key is kept in the OS credential store (macOS Keychain;
    Windows/Linux unverified). Writes made together are committed in one
    transaction. If the store or key is unavailable the app stops with an
    error; it never falls back to localStorage. An existing localStorage
    vault is moved in once (copy → verify → delete).
  - **Browser / web client (`npm run dev`, `apps/web`):** localStorage, as
    before. Values are ciphertext + wrapped keys, but item counts and sizes
    are visible and writes are not transactional.
- **Recovery key: shown once, never stored readable.** `createVault` returns
  a 32-byte base64url recovery key; only its SHA-256-derived KEK's wrapping
  of the master key is stored. Losing both the passphrase and the recovery
  key means losing access — there is no reset.
- **No server / sync.** Items, favourites and trash live only on this device.
- No autofill and no browser extension UI.

## Layout

```
src/
  main.tsx            entry (StrictMode, index.css, App)
  index.css           Tailwind + dark premium theme (.card/.btn/.input)
  App.tsx             full shell: lock screen, onboarding, views, auto-lock
  vault.ts            encrypted local vault (do not edit casually)
  storage/            StorageBackend selection: SQLCipher via Tauri, else localStorage;
                      one-time localStorage -> SQLCipher migration
  components/
    Sidebar.tsx       Vaults / Categories / Tags / Security Health
    SearchPalette.tsx Cmd/Ctrl+K palette, arrows + Enter
    HealthView.tsx    Watchtower-style score, weak + reused passwords
    ItemList.tsx      item list (companion agent)
    ItemDetail.tsx    item detail (companion agent)
    ItemForm.tsx      create/edit form (companion agent)
    PasswordGenerator.tsx  generator (companion agent)
  utils/
    health.ts         computeHealth (companion agent)
```

## Notes

- `importEncrypted` requires an unlocked vault and merges rows by id,
  keeping the higher revision. Rows with an older revision are skipped; a
  decrypt failure or id mismatch rejects the whole file and nothing is
  written. Trash rows are excluded from `exportEncrypted`.
- `toggleFavorite` flips the flag in memory immediately and re-encrypts
  asynchronously; `App.tsx` refreshes the list right after the call.
- `ItemList`'s `onSelect` takes an item **id** (`(id: string) => void`),
  while `SearchPalette`'s `onSelect` takes the `VaultItem` — `App.tsx`
  handles both.
