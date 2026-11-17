# Extension sync — plan (NOT implemented)

Status, 18 Nov 2026: the extension has its own vault in `chrome.storage.local`
(see `src/lib/vault-ext.ts`). It has no account sign-in, makes no network
requests and does not sync. Nothing in this file exists in code yet.

The **supported way** to bring a vault into the extension today is
**restore from an encrypted backup**: desktop → Settings → export an
encrypted backup (format v2) → extension options page → *Restore from
backup* (passphrase or recovery key) into an empty extension vault. It is a
one-time copy; later changes on either side are not synced. The popup
onboarding and the options page say so. Proven in real Chromium by
`tests/e2e-web-restore/extension-restore.e2e.test.ts`.

## What already exists and will be reused

| Piece | Where | What it gives the extension |
|---|---|---|
| Sync engine | `packages/sync` (`SyncClient`, `applyRemoteEvents`, queue, checkpoint, conflicts) | Push queue that survives offline, pull with AEAD check before apply, monotonic revisions, conflicts keep both versions |
| API client | `packages/sdk` (`VaultApiClient`, `createSyncClient`, `enrollDevice`) | Bearer-token `fetch` to the Rails API; `POST /v1/devices/enroll` |
| Reference wiring | `apps/desktop/src/sync/engine.ts` | Account ↔ server-vault binding (refuses another account), per-install device id, `wireItemId`, conflicts persisted encrypted under the Vault Key, debounce + retry, runs only while signed in AND unlocked |
| Same keys | `restoreEncrypted` in `vault-ext.ts` | After restoring a desktop backup the extension holds the **same** Master Key and Vault Key (`envelopeToStoredKeys`), so it can decrypt events the desktop pushed. This is the cryptographic precondition for sync. |
| Server | `apps/api`: `devices#enroll`, `vaults/:id/key-envelopes`, `sync#pull`, `sync#push` | Device records with a signing public key; per-recipient `encrypted_key` envelopes (rotated on device revoke) |

## Target flow: pair the extension with an existing device

1. **Sign in** to the account from the options page (a full tab; the popup
   closes on focus loss). Account auth is not vault unlock
   (`specs/key-management.md`).
2. **Enrol** the extension as a device: generate a device signing key pair in
   the worker, `POST /v1/devices/enroll` (step-up required by the API). The
   private key is stored encrypted under the Vault Key once the vault is
   open, or in worker memory only until then.
3. **Get the vault keys**, one of:
   - **Passphrase after auth:** fetch the account's wrapped key envelope and
     unwrap it locally with the master passphrase (Argon2id, same profile as
     everywhere). Needs an API path that returns the passphrase-wrapped
     envelope to an authenticated, enrolled device.
   - **Transfer from a trusted device:** desktop/mobile wraps the Master Key
     to the extension's device key (per-recipient `key-envelopes`). Needs the
     HPKE/key-transfer protocol, which no client implements yet (desktop
     `SharesView` says HPKE is not implemented).
   - **Interim (works today for the key part):** restore a desktop backup, then
     sign in. The keys already match; only steps 1, 2, 4 are missing.
4. **Bind** to the account's server vault exactly like desktop
   `ensureBinding` (oldest vault of the account; refuse a different account
   or a vanished vault), then run `SyncClient.syncAll()` in the worker.
5. **Existing standalone extension vault** (different keys): migrate only on
   explicit user confirmation — the worker decrypts each item with the old
   Vault Key and re-encrypts it under the account Vault Key, all-or-nothing,
   then enqueues pushes. Never silent, never a partial write. Until that
   exists, pairing requires an empty extension vault (same rule as restore).

## Extension-specific engineering

- **All sync code in the background worker.** Popup/options get status and
  conflict summaries only; content scripts get nothing (same sender rules as
  today, `README.md`).
- **MV3 worker can die at any time.** Queue, checkpoint and binding live in
  `chrome.storage.local` (ciphertext and opaque ids only; storage is already
  restricted to trusted contexts). `packages/sync`'s `SyncStorage` is
  synchronous (`localStorage`-shaped); the worker has only async storage.
  Either `packages/sync` grows an async storage interface (owner: sync
  package), or the extension loads a write-through in-memory cache before
  every sync run. Decide with the sync owner; do not fork the engine.
- **Scheduling:** push after each local save; pull on unlock, on popup open,
  and on a `chrome.alarms` period (Chrome minimum 30 s). Sync only while
  signed in AND unlocked (desktop rule); auto-lock stops it; the queue stays.
- **Session token:** a bearer credential. Keep it in `chrome.storage.session`
  (memory, cleared at browser exit) or encrypted under the Vault Key — to be
  fixed by the device-identity spec. Never in plaintext `storage.local`.
- **Network permission:** one narrow host permission for the API origin
  only (e.g. `https://api.<domain>/*`), added to `public/manifest.json` and to
  the exact-permission assertion in `tests/manifest.test.ts`. No broad hosts.
  With that host permission the worker's `fetch` is not subject to CORS, so
  the API does not have to allow `chrome-extension://` origins.
- **Vault bookkeeping:** extension rows track only `revision`. Sync needs what
  desktop `vault.ts` has (synced base revision, `markPushed`,
  `rebaseForPush`, `storeRemoteItem` / `storeRemoteTombstone`,
  `buildSyncPush`, encrypted conflict store). Extract a storage-agnostic vault
  core shared by desktop and extension instead of a third copy.
- **Item ids:** the popup already creates `crypto.randomUUID()` ids, which
  `wireItemId` passes through unchanged.

## Must exist first (blocking)

1. `specs/device-identity.md` (being written elsewhere): how a browser
   extension authenticates, enrols, stores its device key and session,
   signs sync events, and is revoked.
2. A way for a new device to obtain the vault keys after auth (passphrase
   envelope endpoint and/or trusted-device transfer with HPKE), specified and
   implemented on at least one existing client.
3. Async storage support in `packages/sync` (or an agreed adapter).
4. The shared vault core with sync bookkeeping (point above).
5. Tests before shipping: a real-Chromium + real-Rails two-client e2e
   (desktop/web ↔ extension) in the style of `tests/sync-e2e`, plus worker
   restart mid-push, offline queue, conflict keep-both, revoked device.

Until all five exist the extension stays a separate vault, says so in its UI,
and restore-from-backup remains the supported path.
