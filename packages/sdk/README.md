# @my-secrect/sdk — the one import path for the API + sync

Everything an app needs to talk to the Rails API and sync, from one module:

```ts
import { VaultApiClient, SyncClient, createSyncClient } from '../../sdk/src/index';
```

(The workspace uses relative `src/index` imports until package names resolve;
the import path above is the single entry point — never import sync-client
or API helpers from anywhere else.)

## One-line integration (apps own the wiring — this package only provides it)

```ts
import { createSyncClient, localStorageSyncStorage, enqueuePush } from '../../sdk/src/index';

const sync = createSyncClient({
  baseUrl: API_BASE_URL,
  getToken: () => sessionToken(),
  vaultId,
  deviceId,
  storage: localStorageSyncStorage(),
  decrypt: async (event) => decryptRemoteEvent(event),
  getLocalState: () => localItemsById(),
  saveLocalItem: (item, revision) => saveItemLocally(item, revision),
  deleteLocalItem: (itemId, revision) => tombstoneLocally(itemId, revision),
});

// Offline edit: encrypt locally, enqueue, sync when online.
enqueuePush(storage, { vault_id: vaultId, item_id, base_revision, encrypted_payload, encrypted_item_key, encryption_version: 1, operation: 'upsert' });

// Full sync: push queued changes (FIFO), then pull + apply remote events.
const result = await sync.syncAll();
```

`decrypt` MUST AEAD-verify with the libsodium adapter and throw on tag
failure. `getToken` returns the Bearer session token (account auth only —
it never unlocks a vault).

## How sync works

- **Push** (`sync.pushQueue()`): drains the persisted offline queue FIFO.
  An entry leaves the queue ONLY on a 2xx response. Offline/network failure
  stops the drain and keeps the rest queued in order for replay. A 409
  (stale `base_revision`) is NOT retried: the local item is kept, the
  conflict is surfaced on the next pull, and the user resolves it — never
  last-write-wins, never a silent overwrite.
- **Pull** (`sync.pull()`): fetches events since the saved checkpoint.
  Upsert events carry `encrypted_payload` + `encrypted_item_key` (+
  `encryption_version`) at the event revision; delete events carry
  `tombstone: true` and no ciphertext. Events are applied only after the
  `decrypt` callback AEAD-verifies them; a failed tag rejects the event
  and applies nothing. The checkpoint advances only after events apply.
- **Conflicts**: both versions are kept (`SyncConflict`, resolution
  `unresolved` until the user chooses). Resolution is a user choice.
- **`syncAll()`** = push, then pull. Offline returns `{ offline: true }`
  with the queue intact; the caller retries later. Nothing is lost.

## API client

`VaultApiClient` (`listVaults`, `getItem`, `putItem`, `syncPull`,
`syncPush`, plus blob helpers `createBlobUploadSession` /
`completeBlobUpload` / `createBlobDownloadSession`) sends ONLY ciphertext
+ opaque ids. Non-2xx responses throw `ApiError` (with `.status`); the
message keeps the `API <status> <path>` shape SyncClient relies on to
detect 409s. Nothing in this package logs request bodies.

## Blobs (chunked encrypted storage)

```ts
const session = await api.createBlobUploadSession(vaultId, { blob_id, part_count, ciphertext_size, encrypted_manifest });
// PUT each ciphertext chunk to session.parts[i].url, then:
await api.completeBlobUpload(blob_id, parts.map(p => ({ part_number: p.part_number, ciphertext_size: p.ciphertext_size, ciphertext_sha256_b64: p.hash })));
const dl = await api.createBlobDownloadSession(blob_id); // includes encrypted_manifest — see packages/storage downloadBlob()
```

The encrypted manifest carries the wrapped File Key; downloads are
decryptable from stored data alone. See `packages/storage/src/upload.ts`.

## What this package does NOT do

- It does not wire sync into any app (apps/ is owned separately).
- It does not decrypt anything itself — decryption is the caller's
  `decrypt` callback (libsodium adapter) and the storage helpers.
- It does not store CVV/PIN/live OTPs, and it never sends plaintext
  titles/tags/types/relations to the server.
