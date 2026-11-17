/**
 * SyncEngine — wires packages/sync (SyncClient) + the SDK into the local
 * desktop vault (vault.ts). Used by the desktop app and, unchanged, by the
 * web app (which reuses the desktop App) and by the two-client Node test.
 *
 * Security properties (enforced here, not just documented):
 *  - The server only ever receives what vault.ts already stored as
 *    ciphertext (payload + wrapped item key) and opaque ids. This file never
 *    touches a key and never sends plaintext.
 *  - Auth is separate from unlock: the engine only runs while the caller says
 *    "signed in AND unlocked"; it needs the Vault Key only through vault.ts
 *    (decryptSyncEvent), never to talk to the server.
 *  - Conflict records hold DECRYPTED item versions, so they are persisted
 *    encrypted under the Vault Key (never in plaintext localStorage).
 *  - Nothing is resolved silently: conflicts wait for the user; 'Keep both'
 *    creates a copy and keeps the local item; failed decrypts, 4xx/5xx and
 *    unreadable stores all surface as status.error text.
 *  - This local vault is bound to one account + server vault; a different
 *    account is refused instead of pushing into the wrong vault, and so is a
 *    server vault this device's Vault Key cannot open (state 'vault_mismatch':
 *    nothing is pushed — a device that created a new vault instead of
 *    restoring must not upload items no other device can read).
 */
import { createSyncClient, VaultApiClient } from '../../../../packages/sdk/src/index';
import {
  SYNC_CHECKPOINT_KEY,
  SYNC_CONFLICTS_KEY,
  enqueuePush,
  loadConflicts,
  loadQueue,
  localStorageSyncStorage,
  removeQueuedPushEntry,
  saveConflicts,
  wireItemId,
} from '../../../../packages/sync/src/index';
import type { SyncConflict, SyncEvent, SyncStorage } from '../../../../packages/sync/src/index';
import type { SyncClient } from '../../../../packages/sync/src/sync-client';
import type { VaultItem } from '../../../../packages/core/src/types';
import { sha256 } from '../../../../packages/crypto-adapters/src/index';
import {
  buildSyncPush,
  decryptSyncEvent,
  decryptWithVaultKey,
  encryptWithVaultKey,
  getSyncLocalState,
  isUnlocked,
  listRowIds,
  markPushed,
  onVaultMutation,
  rebaseForPush,
  storeRemoteItem,
  storeRemoteTombstone,
  upsertItem,
} from '../vault';

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'offline' | 'error' | 'vault_mismatch';

export interface SyncStatus {
  state: SyncState;
  /** Visible error text for state 'error' (and the reason shown with 'offline'). */
  error: string | null;
  lastSyncedAt: string | null;
  /** Local changes waiting to be pushed. */
  pending: number;
  unresolvedConflicts: number;
}

export interface SyncEngineConfig {
  /** API base incl. the `/api` prefix, e.g. http://localhost:3102/api */
  baseUrl: string;
  getToken: () => Promise<string | null>;
  /** Account identity this vault is bound to (the signed-in email). */
  accountKey: string;
  /** Called after sync changed local items (re-render). */
  onItemsChanged?: () => void;
  onStatus?: (s: SyncStatus) => void;
  /** Called when the server answers 401 (session gone). */
  onUnauthorized?: () => void;
  /** Override for tests / non-browser hosts. Default: localStorage. */
  storage?: SyncStorage;
  /** Delay before a local edit is pushed (ms). Default 400. */
  pushDebounceMs?: number;
  /** Retry delay while offline / after an error (ms). Default 10000. */
  retryMs?: number;
}

const LS_DEVICE_ID = 'my-secrect.sync.device-id.v1';
const LS_BINDING = 'my-secrect.sync.binding.v1';
const LS_CONFLICTS_ENC = 'my-secrect.sync.conflicts.enc.v1';
const LS_LAST_SYNC = 'my-secrect.sync.last-synced-at.v1';

interface Binding { account: string; vault_id: string }
/** GET /v1/vaults entry. encrypted_metadata is ciphertext under the creator's Vault Key. */
interface ServerVault { id: string; created_at: string; encrypted_metadata?: string | null }

/** This device's Vault Key does not open the account's server vault. */
export class VaultMismatchError extends Error {
  constructor() {
    super(
      "This device's vault does not match your account's vault on the server: it is encrypted with a different key "
      + '(for example, a new vault was created here instead of restoring). Sync is off and nothing was uploaded. '
      + "To use your account's vault on this device, restore it from a backup (or with its recovery key).",
    );
    this.name = 'VaultMismatchError';
  }
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Stable per-install device id (also sent as the SyncClient deviceId). */
export function getDeviceId(kv: SyncStorage = localStorageSyncStorage()): string {
  const existing = kv.get(LS_DEVICE_ID);
  if (existing) return existing;
  const id = randomUuid();
  kv.set(LS_DEVICE_ID, id);
  return id;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}
function isNetworkError(err: unknown): boolean {
  if (statusOf(err) !== null) return false;
  return /network|fetch|ECONNREFUSED|ENOTFOUND|ECONNRESET|offline|timeout|socket/i.test(errText(err));
}

/**
 * SyncStorage for SyncClient. The conflict list holds decrypted items, so it
 * lives in memory and is persisted ENCRYPTED under the Vault Key. The
 * checkpoint is written only after any pending conflict write finished, so a
 * crash can never advance past an event whose conflict was not saved. The
 * queue holds ciphertext only and is written straight through.
 */
class EngineStorage implements SyncStorage {
  private overlay = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  constructor(private base: SyncStorage) {}

  async hydrate(): Promise<void> {
    // A plaintext conflict list must never exist on disk.
    this.base.remove(SYNC_CONFLICTS_KEY);
    const enc = this.base.get(LS_CONFLICTS_ENC);
    if (enc) {
      let plain: string;
      try {
        plain = await decryptWithVaultKey(enc);
      } catch (err) {
        throw new Error(`stored sync conflicts could not be decrypted (kept untouched on disk): ${errText(err)}`);
      }
      this.overlay.set(SYNC_CONFLICTS_KEY, plain);
    }
  }

  get(key: string): string | null {
    return this.overlay.get(key) ?? this.base.get(key);
  }

  set(key: string, value: string): void {
    if (key === SYNC_CONFLICTS_KEY) {
      this.overlay.set(key, value);
      this.chain = this.chain.then(async () => {
        try {
          this.base.set(LS_CONFLICTS_ENC, await encryptWithVaultKey(value));
        } catch (err) {
          this.failure = new Error(`could not persist sync conflicts: ${errText(err)}`);
        }
      });
    } else if (key === SYNC_CHECKPOINT_KEY) {
      this.overlay.set(key, value);
      this.chain = this.chain.then(() => { this.base.set(key, value); });
    } else {
      this.base.set(key, value);
    }
  }

  remove(key: string): void {
    this.overlay.delete(key);
    this.base.remove(key);
  }

  /** Wait for pending persists; throws if one failed (never swallowed). */
  async flush(): Promise<void> {
    await this.chain;
    if (this.failure) {
      const f = this.failure;
      this.failure = null;
      throw f;
    }
  }
}

export class SyncEngine {
  private storage: EngineStorage;
  private kv: SyncStorage;
  private api: VaultApiClient;
  private client: SyncClient | null = null;
  private vaultId: string | null = null;
  private wire = new Map<string, string>();
  private reverse = new Map<string, string>();
  private events = new Map<string, SyncEvent>();
  private unsub: (() => void) | null = null;
  private started = false;
  private again = false;
  private dirtyIds = new Set<string>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineHandler: (() => void) | null = null;
  private status: SyncStatus = { state: 'disabled', error: null, lastSyncedAt: null, pending: 0, unresolvedConflicts: 0 };
  readonly deviceId: string;

  constructor(private cfg: SyncEngineConfig) {
    this.kv = cfg.storage ?? localStorageSyncStorage();
    this.storage = new EngineStorage(this.kv);
    this.deviceId = getDeviceId(this.kv);
    this.api = new VaultApiClient({ baseUrl: cfg.baseUrl, getToken: cfg.getToken });
  }

  getStatus(): SyncStatus { return this.status; }

  /** Conflicts (unresolved first). Decrypted versions, from the encrypted store. */
  getConflicts(): SyncConflict[] {
    const all = loadConflicts(this.storage);
    return [...all.filter((c) => c.resolution === 'unresolved'), ...all.filter((c) => c.resolution !== 'unresolved')];
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    const queue = loadQueue(this.storage);
    const unresolved = loadConflicts(this.storage).filter((c) => c.resolution === 'unresolved').length;
    this.status = { ...this.status, pending: queue.length, unresolvedConflicts: unresolved, ...patch };
    this.cfg.onStatus?.(this.status);
  }

  /** Begin syncing. Requires an unlocked vault (the caller guarantees sign-in). */
  async start(): Promise<void> {
    if (this.started) return;
    if (!isUnlocked()) throw new Error('sync: vault is locked');
    this.started = true;
    try {
      await this.storage.hydrate();
    } catch (err) {
      this.setStatus({ state: 'error', error: errText(err) });
      return;
    }
    if (!this.started) return; // stopped while hydrating (lock / sign-out)
    this.unsub = onVaultMutation((m) => {
      if (m.kind === 'purge') return; // "Delete forever" is device-local; the delete before it is not
      this.dirtyIds.add(m.id);
      // A purge can follow the delete before the debounced push runs, and it
      // removes the row that push would be built from. Queue the tombstone now:
      // it carries no ciphertext and needs no network.
      if (m.kind === 'delete') this.queueTombstone(m.id);
      this.schedulePush();
    });
    const g = globalThis as unknown as { addEventListener?: (t: string, h: () => void) => void };
    if (typeof g.addEventListener === 'function') {
      this.onlineHandler = () => { void this.syncNow(); };
      g.addEventListener('online', this.onlineHandler);
    }
    const last = this.kv.get(LS_LAST_SYNC);
    this.setStatus({ state: 'idle', error: null, lastSyncedAt: last });
    // Anything already dirty (created offline, or before sync existed) joins the queue.
    for (const id of listRowIds()) this.dirtyIds.add(id);
    await this.syncNow();
  }

  stop(): void {
    this.started = false;
    this.unsub?.();
    this.unsub = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pushTimer = this.retryTimer = null;
    const g = globalThis as unknown as { removeEventListener?: (t: string, h: () => void) => void };
    if (this.onlineHandler && typeof g.removeEventListener === 'function') g.removeEventListener('online', this.onlineHandler);
    this.onlineHandler = null;
    this.client = null;
    this.vaultId = null;
    this.setStatus({ state: 'disabled', error: null });
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => { this.pushTimer = null; void this.syncNow(); }, this.cfg.pushDebounceMs ?? 400);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.syncNow(); }, this.cfg.retryMs ?? 10_000);
  }

  private async wireIdOf(localId: string): Promise<string> {
    const known = this.wire.get(localId);
    if (known) return known;
    const w = await wireItemId(localId, sha256);
    this.wire.set(localId, w);
    this.reverse.set(w, localId);
    return w;
  }

  /** Bind this local vault to the account's server vault (create it on first use). */
  private async ensureBinding(): Promise<string> {
    if (this.vaultId) return this.vaultId;
    const raw = this.kv.get(LS_BINDING);
    let binding: Binding | null = null;
    if (raw) {
      try { binding = JSON.parse(raw) as Binding; } catch { throw new Error('sync binding record is corrupt; refusing to sync'); }
    }
    if (binding && binding.account !== this.cfg.accountKey) {
      throw new Error(`This local vault is synced with another account (${binding.account}). Sign in with that account to sync it.`);
    }
    const { vaults } = (await this.api.listVaults()) as { vaults: ServerVault[] };
    let id: string | null = null;
    if (binding) {
      const bound = vaults.find((v) => v.id === binding!.vault_id);
      if (!bound) {
        throw new Error('The server no longer has the vault this device was synced with; refusing to push into a different one.');
      }
      if (!(await this.opensVault(bound))) throw new VaultMismatchError();
      id = bound.id;
    } else if (vaults.length > 0) {
      // Deterministic: the oldest vault of the account that this device's Vault Key
      // opens (a second device joins the existing one). None opens => refuse.
      const oldestFirst = [...vaults].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      for (const v of oldestFirst) {
        if (await this.opensVault(v)) { id = v.id; break; }
      }
      if (!id) throw new VaultMismatchError();
    } else {
      const created = await this.api.createVault(await encryptWithVaultKey(`my-secrect vault ${new Date().toISOString()}`));
      id = created.vault.id;
    }
    this.kv.set(LS_BINDING, JSON.stringify({ account: this.cfg.accountKey, vault_id: id } satisfies Binding));
    this.vaultId = id;
    return id;
  }

  /**
   * Whether this device's Vault Key opens the server vault: its encrypted metadata
   * (written with encryptWithVaultKey by the device that created it) passes AEAD,
   * or — for a vault without metadata — its first stored item does. An empty vault
   * without metadata holds nothing this device could disagree with.
   */
  private async opensVault(vault: ServerVault): Promise<boolean> {
    if (!isUnlocked()) throw new Error('sync: vault is locked');
    if (vault.encrypted_metadata) {
      try {
        await decryptWithVaultKey(vault.encrypted_metadata);
        return true;
      } catch {
        return false;
      }
    }
    const { events } = await this.api.syncPull(vault.id);
    const sample = events.find((e) => e.operation === 'upsert' && e.encrypted_payload && e.encrypted_item_key);
    if (!sample) return true;
    try {
      await decryptSyncEvent(sample);
      return true;
    } catch {
      return false;
    }
  }

  /** Stop for good (until a new engine starts) and show why. Nothing more is sent. */
  private halt(state: 'vault_mismatch', message: string): void {
    this.stop();
    this.setStatus({ state, error: message });
  }

  private buildClient(vaultId: string): SyncClient {
    return createSyncClient({
      baseUrl: this.cfg.baseUrl,
      getToken: this.cfg.getToken,
      vaultId,
      deviceId: this.deviceId,
      storage: this.storage,
      decrypt: async (event) => {
        const item = await decryptSyncEvent(event);
        const w = await this.wireIdOf(item.id);
        if (w !== event.item_id) throw new Error('decrypted item id does not belong to this event');
        this.events.set(`${event.item_id}@${event.revision}`, event);
        return item;
      },
      itemMatchesEvent: (item, event) => this.wire.get(item.id) === event.item_id,
      getLocalState: () => getSyncLocalState((id) => this.wire.get(id) ?? id),
      saveLocalItem: (item, revision) => {
        const ev = this.events.get(`${this.wire.get(item.id)}@${revision}`);
        if (!ev) throw new Error('internal: verified event for applied item not found');
        storeRemoteItem(item, revision, ev);
      },
      deleteLocalItem: (wireId, revision) => {
        const local = this.reverse.get(wireId);
        if (local) storeRemoteTombstone(local, revision);
      },
      onPushed: async (entry, res) => {
        const local = this.reverse.get(entry.item_id);
        if (!local) return;
        const state = markPushed(local, res.revision, entry.local_revision ?? -1);
        if (state === 'dirty') this.dirtyIds.add(local); // edited again while in flight
      },
    });
  }

  /** Queue the tombstone of a just-deleted, already-synced row (no-op otherwise). */
  private queueTombstone(localId: string): void {
    const wireId = this.wire.get(localId); // known for every row since the last round
    if (!wireId) return;
    const draft = buildSyncPush(localId, wireId);
    if (draft?.operation === 'delete') enqueuePush(this.storage, { vault_id: this.vaultId ?? '', ...draft });
  }

  /** Turn every locally changed row into a queued push (idempotent). */
  private async enqueueDirty(): Promise<void> {
    const ids = [...this.dirtyIds];
    this.dirtyIds.clear();
    const rowIds = new Set(listRowIds());
    for (const id of ids) {
      const wireId = await this.wireIdOf(id);
      const draft = buildSyncPush(id, wireId);
      const queue = loadQueue(this.storage);
      const queued = queue.find((q) => q.item_id === wireId);
      if (!draft) {
        // Nothing to push any more (e.g. an unsynced item deleted again): drop a stale
        // queue entry — but keep a tombstone whose row was purged ("Delete forever")
        // before it reached the server: the server and other devices must still learn
        // of the delete, or the item would stay live everywhere else.
        const purgedTombstone = queued?.operation === 'delete' && !rowIds.has(id);
        if (queued && !purgedTombstone) removeQueuedPushEntry(this.storage, queued);
        continue;
      }
      if (queued && queued.local_revision === draft.local_revision && queued.operation === draft.operation) continue;
      enqueuePush(this.storage, { vault_id: this.vaultId ?? '', ...draft });
    }
  }

  private runPromise: Promise<void> | null = null;

  /**
   * Push the queue, then pull. Safe to call any time: calls made while a run
   * is in progress coalesce into one follow-up run, and the returned promise
   * resolves when ALL of that work (including the follow-up) is done.
   */
  syncNow(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (this.runPromise) {
      this.again = true;
      return this.runPromise;
    }
    this.runPromise = this.runLoop().finally(() => { this.runPromise = null; });
    return this.runPromise;
  }

  private async runLoop(): Promise<void> {
    let rounds = 0;
    for (;;) {
      this.again = false;
      const retry = await this.syncOnce();
      rounds += 1;
      if (!this.started) return;
      if (this.dirtyIds.size > 0 || this.again) {
        if (rounds < 20) continue; // bounded: a pathological edit storm must not spin forever
      }
      if (retry) this.scheduleRetry();
      return;
    }
  }

  /** One push+pull round. Returns true when a retry should be scheduled. */
  private async syncOnce(): Promise<boolean> {
    this.setStatus({ state: 'syncing', error: null });
    let retry = false;
    try {
      // Queue first (no network needed): an offline edit is persisted in the
      // push queue before we even try to reach the server.
      for (const id of listRowIds()) await this.wireIdOf(id);
      await this.enqueueDirty();
      this.setStatus({});
      const vaultId = await this.ensureBinding();
      if (!this.client) this.client = this.buildClient(vaultId);
      const res = await this.client.syncAll();
      await this.storage.flush();

      // A 409 is an expected stale-revision outcome: it is surfaced as a conflict
      // record (shown in the conflict list) once the pull returns the other
      // version. If no conflict materialised, the 409 stays a visible error.
      const hasConflict = loadConflicts(this.storage).some((c) => c.resolution === 'unresolved');
      const problems: string[] = res.errors.filter((e) => !(hasConflict && /^409 conflict/.test(e)));
      for (const r of res.pulled?.rejected ?? []) problems.push(`item ${r.item_id}: ${r.reason}`);
      for (const s of res.pulled?.skipped ?? []) {
        if (/no ciphertext/i.test(s.reason)) problems.push(`item ${s.item_id}: ${s.reason}`);
      }
      if (problems.some((p) => /unauthorized \(401\)/.test(p))) this.cfg.onUnauthorized?.();
      if (res.pulled && (res.pulled.applied.length > 0 || res.pulled.tombstones.length > 0 || res.pulled.conflicts.length > 0)) {
        this.cfg.onItemsChanged?.();
      }
      if (res.pushed.length > 0) this.cfg.onItemsChanged?.();
      if (res.offline) {
        this.setStatus({ state: 'offline', error: 'Offline — changes are saved locally and will sync when the connection is back.' });
        retry = true;
      } else if (problems.length > 0) {
        this.setStatus({ state: 'error', error: problems.join('\n') });
        retry = true;
      } else {
        const now = new Date().toISOString();
        this.kv.set(LS_LAST_SYNC, now);
        this.setStatus({ state: 'idle', error: null, lastSyncedAt: now });
      }
    } catch (err) {
      const status = statusOf(err);
      if (err instanceof VaultMismatchError) {
        this.halt('vault_mismatch', err.message);
      } else if (status === 401) {
        this.setStatus({ state: 'error', error: 'Sign-in expired (401). Sign in again to sync; local changes stay queued.' });
        this.cfg.onUnauthorized?.();
      } else if (isNetworkError(err)) {
        this.setStatus({ state: 'offline', error: 'Offline — changes are saved locally and will sync when the connection is back.' });
        retry = true;
      } else {
        this.setStatus({ state: 'error', error: errText(err) });
        retry = true;
      }
    }
    return retry;
  }

  /**
   * 'Keep both': the remote version becomes a NEW item (a copy), the local
   * item is kept and re-based so its next push is accepted. Nothing is
   * discarded. For a remote delete there is no remote content to copy: the
   * local item is simply kept (re-pushed over the tombstone).
   * Idempotent: the copy id is derived from the conflict id.
   */
  async resolveKeepBoth(conflictId: string): Promise<void> {
    const all = loadConflicts(this.storage);
    const c = all.find((x) => x.id === conflictId);
    if (!c) throw new Error('conflict not found');
    if (c.resolution !== 'unresolved') return;
    const localId = c.local.id;
    if (c.kind === 'same_item_both_changed') {
      const copyId = await wireItemId(`conflict-copy:${c.id}`, sha256);
      const remote = c.remote;
      const copy: VaultItem = {
        ...remote,
        id: copyId,
        title: `${remote.title} (conflict copy)`,
        deleted_at: null,
      };
      await upsertItem(copy);
    }
    rebaseForPush(localId, c.remote_revision);
    saveConflicts(this.storage, all.map((x) => (x.id === c.id ? { ...x, resolution: 'kept_both' as const, resolved_at: new Date().toISOString() } : x)));
    await this.storage.flush();
    this.cfg.onItemsChanged?.();
    this.setStatus({});
    this.dirtyIds.add(localId);
    await this.syncNow();
  }
}

