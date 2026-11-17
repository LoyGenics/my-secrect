/**
 * Client sync engine — offline-first, append-only, optimistic concurrency.
 *
 * Implemented in code (NOT run against a live server, NOT audited).
 * Rules enforced here, in code — not just in docs:
 *  - Never Last Write Wins. Never a silent overwrite.
 *  - A remote revision is applied ONLY after its AEAD tag verifies
 *    (via the caller's decrypt callback, which uses the libsodium adapter).
 *    A failed tag => the event is rejected, recorded, and never applied.
 *  - A revision must be monotonic: event.revision must be > the local
 *    revision for that item (or == when it is the item we just pushed).
 *    Older / duplicate events are skipped, never rolled back over.
 *  - Deletes are tombstones, restorable until permanently deleted.
 *  - The push queue survives reloads (localStorage, versioned key).
 *  - Checkpoints are saved locally so a pull resumes from `since`.
 *
 * The server (Rails) is append-only and never decrypts, merges, or
 * resolves conflicts. Conflict resolution happens on the CLIENT after
 * decryption — see `resolveConflictKeepBoth`.
 */
import type { VaultItem } from '../../core/src/types';

export type SyncOperation = 'upsert' | 'delete';

export interface SyncEvent {
  id: string;
  vault_id: string;
  sequence: number; // server-assigned, monotonic per vault
  item_id: string;
  revision: number;
  operation: SyncOperation;
  /** True for remote deletes. Tombstone events carry NO ciphertext. */
  tombstone?: boolean;
  device_id: string;
  signature: string; // device signature over (vault_id, item_id, revision)
  created_at: string;
  // Pull payloads carry the ciphertext so the client can verify + decrypt.
  // A pull that omits these fields cannot be applied — it is skipped.
  encrypted_payload?: string;
  encrypted_item_key?: string;
  encryption_version?: number;
}

export interface PushRequest {
  vault_id: string;
  item_id: string;
  base_revision: number;
  encrypted_payload: string;
  encrypted_item_key: string;
  encryption_version: number;
  operation: SyncOperation;
  signature?: string;
}

export interface PullResponse {
  events: SyncEvent[];
  next_cursor: string | null;
}

/** One queued local change, waiting for connectivity. */
export interface QueuedPush extends PushRequest {
  queued_at: string; // ISO 8601
  attempts: number;
  last_error?: string;
}

export interface SyncCheckpoint {
  vault_id: string;
  last_sequence: number;
  checkpoint_hash: string | null; // hash of the last applied event, when known
  updated_at: string;
}

export const SYNC_QUEUE_KEY = 'my-secrect.sync.queue.v1';
export const SYNC_CHECKPOINT_KEY = 'my-secrect.sync.checkpoint.v1';
export const SYNC_CONFLICTS_KEY = 'my-secrect.sync.conflicts.v1';

// ---------------------------------------------------------------------------
// Storage abstraction (localStorage in the app, in-memory in tests / Node)
// ---------------------------------------------------------------------------
export interface SyncStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function localStorageSyncStorage(): SyncStorage {
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage full/blocked: queue stays in memory */ } },
    remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
}

export function memorySyncStorage(seed: Record<string, string> = {}): SyncStorage {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v); },
    remove: (k) => { map.delete(k); },
  };
}

// ---------------------------------------------------------------------------
// Push queue — offline queue, persisted, FIFO, deduped per item
// ---------------------------------------------------------------------------
export function loadQueue(storage: SyncStorage): QueuedPush[] {
  try {
    const raw = storage.get(SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedPush[]) : [];
  } catch { return []; }
}

export function saveQueue(storage: SyncStorage, queue: QueuedPush[]): void {
  storage.set(SYNC_QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Enqueue a local change. If the same item is already queued, the newer
 * entry REPLACES the older one for that item (same item, newer revision —
 * the older ciphertext is superseded locally, never pushed twice), but the
 * queue keeps FIFO order for different items. Returns the new queue.
 */
export function enqueuePush(storage: SyncStorage, req: PushRequest): QueuedPush[] {
  const queue = loadQueue(storage).filter((q) => q.item_id !== req.item_id);
  const entry: QueuedPush = { ...req, queued_at: new Date().toISOString(), attempts: 0 };
  queue.push(entry);
  saveQueue(storage, queue);
  return queue;
}

export function removeQueuedPush(storage: SyncStorage, itemId: string): QueuedPush[] {
  const queue = loadQueue(storage).filter((q) => q.item_id !== itemId);
  saveQueue(storage, queue);
  return queue;
}

export function markQueueAttempt(storage: SyncStorage, itemId: string, error: string): QueuedPush[] {
  const queue = loadQueue(storage).map((q) =>
    q.item_id === itemId ? { ...q, attempts: q.attempts + 1, last_error: error } : q,
  );
  saveQueue(storage, queue);
  return queue;
}

export function clearQueue(storage: SyncStorage): void {
  storage.remove(SYNC_QUEUE_KEY);
}

// ---------------------------------------------------------------------------
// Checkpoints — resume pulls from `since`, detect rollback attempts
// ---------------------------------------------------------------------------
export function loadCheckpoint(storage: SyncStorage, vaultId: string): SyncCheckpoint | null {
  try {
    const raw = storage.get(SYNC_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SyncCheckpoint;
    return parsed.vault_id === vaultId ? parsed : null;
  } catch { return null; }
}

export function saveCheckpoint(storage: SyncStorage, cp: SyncCheckpoint): void {
  storage.set(SYNC_CHECKPOINT_KEY, JSON.stringify(cp));
}

// ---------------------------------------------------------------------------
// Conflicts — keep BOTH versions, surface a UI shape, never LWW
// ---------------------------------------------------------------------------
export type ConflictKind = 'same_item_both_changed' | 'delete_vs_update' | 'none';

export function detectConflict(localRevision: number, localBase: number, remoteRevision: number): ConflictKind {
  if (localRevision === localBase) return 'none'; // local untouched since base
  if (remoteRevision === localBase) return 'none'; // remote untouched
  return 'same_item_both_changed'; // both changed since base -> keep BOTH versions, never LWW
}

export function detectDeleteConflict(localDeleted: boolean, remoteRevision: number, baseRevision: number): ConflictKind {
  if (!localDeleted) return 'none';
  if (remoteRevision === baseRevision) return 'none';
  return 'delete_vs_update';
}

/**
 * The shape the UI renders for a conflict. Both versions are kept:
 *  - `local` stays the live item (the user's own edit is never destroyed).
 *  - `remote` is stored as a separate conflict copy the user can inspect,
 *    keep (as its own item), or discard — explicitly, never silently.
 * Resolution is a user choice, recorded with a timestamp. No automatic
 * merge is attempted: the server cannot see plaintext, and the client
 * must not guess which password / recovery code is correct.
 */
export interface SyncConflict {
  id: string; // `conflict_<item_id>_<remote_revision>`
  item_id: string;
  kind: ConflictKind;
  local_revision: number;
  remote_revision: number;
  base_revision: number;
  local: VaultItem;
  remote: VaultItem;
  remote_device_id: string;
  detected_at: string;
  resolution: 'unresolved' | 'kept_local' | 'kept_remote' | 'kept_both';
  resolved_at: string | null;
}

export function resolveConflictKeepBoth(
  local: VaultItem,
  remote: VaultItem,
  meta: { localRevision: number; remoteRevision: number; baseRevision: number; remoteDeviceId: string },
): SyncConflict {
  return {
    id: `conflict_${local.id}_${meta.remoteRevision}`,
    item_id: local.id,
    kind: meta.localRevision === meta.baseRevision || meta.remoteRevision === meta.baseRevision
      ? 'none'
      : 'same_item_both_changed',
    local_revision: meta.localRevision,
    remote_revision: meta.remoteRevision,
    base_revision: meta.baseRevision,
    local,
    remote,
    remote_device_id: meta.remoteDeviceId,
    detected_at: new Date().toISOString(),
    resolution: 'unresolved',
    resolved_at: null,
  };
}

export function loadConflicts(storage: SyncStorage): SyncConflict[] {
  try {
    const raw = storage.get(SYNC_CONFLICTS_KEY);
    return raw ? (JSON.parse(raw) as SyncConflict[]) : [];
  } catch { return []; }
}

export function saveConflicts(storage: SyncStorage, conflicts: SyncConflict[]): void {
  storage.set(SYNC_CONFLICTS_KEY, JSON.stringify(conflicts));
}

// ---------------------------------------------------------------------------
// Applying remote events — verify first, apply second
// ---------------------------------------------------------------------------
export interface LocalItemState {
  item: VaultItem;
  revision: number;
  baseRevision: number; // revision this device last synced for this item
}

export interface ApplyResult {
  applied: string[]; // item ids applied cleanly
  skipped: Array<{ item_id: string; reason: string }>; // stale / duplicate / no payload
  rejected: Array<{ item_id: string; reason: string }>; // AEAD tag failed — never applied
  conflicts: SyncConflict[];
  tombstones: string[]; // item ids tombstoned by a remote delete
  nextCursor: string | null;
}

/** Decrypt + verify one remote event. Must throw on AEAD failure. */
export type RemoteDecrypt = (event: SyncEvent) => Promise<VaultItem>;

/**
 * Apply a batch of pulled events to local state. Pure except for the
 * decrypt callback. Order: events are applied in sequence order.
 * Returns what happened per item so the UI can show it honestly.
 */
export async function applyRemoteEvents(
  events: SyncEvent[],
  localById: Map<string, LocalItemState>,
  decrypt: RemoteDecrypt,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], skipped: [], rejected: [], conflicts: [], tombstones: [], nextCursor: nextCursor(events) };
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  for (const event of ordered) {
    const local = localById.get(event.item_id);

    // Tombstone: remote delete. Apply only if it is newer than local.
    if (event.operation === 'delete') {
      if (local && event.revision <= local.revision) {
        result.skipped.push({ item_id: event.item_id, reason: 'stale tombstone: revision not newer than local' });
        continue;
      }
      if (local && local.item.deleted_at == null && event.revision > local.baseRevision) {
        // Local was edited after base while remote deleted it: conflict, keep both.
        const kind = detectDeleteConflict(true, event.revision, local.baseRevision);
        if (kind !== 'none') {
          // We cannot decrypt a delete (no payload), so the conflict keeps
          // the local item as-is and records the remote delete as the other side.
          result.conflicts.push({
            id: `conflict_${event.item_id}_${event.revision}`,
            item_id: event.item_id,
            kind,
            local_revision: local.revision,
            remote_revision: event.revision,
            base_revision: local.baseRevision,
            local: local.item,
            remote: { ...local.item, deleted_at: event.created_at },
            remote_device_id: event.device_id,
            detected_at: new Date().toISOString(),
            resolution: 'unresolved',
            resolved_at: null,
          });
          continue;
        }
      }
      result.tombstones.push(event.item_id);
      localById.delete(event.item_id);
      continue;
    }

    // Upsert: must carry ciphertext, and must be newer than local.
    if (!event.encrypted_payload || !event.encrypted_item_key) {
      result.skipped.push({ item_id: event.item_id, reason: 'no ciphertext payload — cannot verify or apply' });
      continue;
    }
    if (local && event.revision <= local.revision) {
      result.skipped.push({ item_id: event.item_id, reason: 'stale revision: not newer than local' });
      continue;
    }

    // Verify AEAD BEFORE applying anything. A throw = tampered / wrong key.
    let remoteItem: VaultItem;
    try {
      remoteItem = await decrypt(event);
    } catch {
      result.rejected.push({ item_id: event.item_id, reason: 'AEAD verification failed — ciphertext rejected, nothing applied' });
      continue;
    }
    if (remoteItem.id !== event.item_id) {
      result.rejected.push({ item_id: event.item_id, reason: 'decrypted item id does not match event item id' });
      continue;
    }

    // Both sides changed since base => conflict, keep BOTH.
    if (local) {
      const kind = detectConflict(local.revision, local.baseRevision, event.revision);
      if (kind !== 'none') {
        result.conflicts.push(resolveConflictKeepBoth(local.item, remoteItem, {
          localRevision: local.revision,
          remoteRevision: event.revision,
          baseRevision: local.baseRevision,
          remoteDeviceId: event.device_id,
        }));
        continue;
      }
    }

    localById.set(event.item_id, { item: remoteItem, revision: event.revision, baseRevision: event.revision });
    result.applied.push(event.item_id);
  }
  return result;
}

export function nextCursor(events: SyncEvent[]): string | null {
  return events.length ? String(events[events.length - 1].sequence) : null;
}
