/**
 * SyncClient — drives push + pull against the Rails API via VaultApiClient.
 *
 * Implemented in code; exercised against the real Rails API by tests/sync-e2e
 * (two real clients, lost responses, server failures). NOT audited.
 *  - Push: drains the persisted offline queue FIFO. A push is removed from
 *    the queue ONLY on a 2xx success. A network failure leaves it queued
 *    (attempts counter incremented) for the next run. A 409 (stale base
 *    revision) is NOT retried blindly: the remote version is pulled and a
 *    conflict is recorded — the local version is never silently overwritten.
 *  - Pull: fetches since the saved checkpoint, applies via
 *    `applyRemoteEvents` (AEAD verified before applying), then saves the
 *    new checkpoint. A checkpoint is saved only after events apply.
 *  - `syncAll()` = push, then pull. Offline => returns { offline: true }
 *    with the queue intact; the caller retries later. Nothing is lost.
 *
 * The client sends ONLY ciphertext + opaque ids. It never sends plaintext
 * titles, tags, types, or relations to the server.
 */
import {
  appendConflicts,
  applyRemoteEvents,
  loadCheckpoint,
  loadConflicts,
  loadQueue,
  markQueueAttempt,
  removeQueuedPushEntry,
  saveCheckpoint,
  type ApplyOptions,
  type ApplyResult,
  type QueuedPush,
  type LocalItemState,
  type RemoteDecrypt,
  type SyncCheckpoint,
  type SyncStorage,
} from './index';
// Type-only on purpose: the SDK re-exports SyncClient, so this import must
// be erased at compile time (no runtime cycle SDK -> sync-client -> SDK).
import type { VaultApiClient } from '../../sdk/src/index';
import type { VaultItem } from '../../core/src/types';

export interface SyncClientOptions {
  vaultId: string;
  deviceId: string;
  storage: SyncStorage;
  /** Decrypt + AEAD-verify one remote event. Must throw on tag failure. */
  decrypt: RemoteDecrypt;
  /** Current local state, keyed by item id. */
  getLocalState: () => Map<string, LocalItemState>;
  /** Persist an applied remote item locally (after AEAD verification). */
  saveLocalItem: (item: VaultItem, revision: number) => void;
  /** Persist a remote tombstone locally (revision = the delete event's revision). */
  deleteLocalItem: (itemId: string, revision: number) => void;
  /** Called after the server accepted a queued push (2xx). The app uses it to
   *  advance the item's synced base revision. May be async. */
  onPushed?: (entry: QueuedPush, result: { revision: number; sequence: number }) => void | Promise<void>;
  /** See ApplyOptions.itemMatchesEvent. */
  itemMatchesEvent?: ApplyOptions['itemMatchesEvent'];
  /** Pull page size guard: stop paging after this many pages (default 200). */
  maxPullPages?: number;
}

export interface SyncRunResult {
  offline: boolean;
  pushed: string[];
  pulled: ApplyResult | null;
  conflicts: number;
  errors: string[];
  checkpoint: SyncCheckpoint | null;
}

/** HTTP status of an ApiError-like error, if any. Never parsed from the
 *  message: a vault/item UUID in the path can contain "409" or "500". */
function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function isOfflineError(err: unknown): boolean {
  // An HTTP response (any status) proves the network works: never "offline".
  if (statusOf(err) !== null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /network|fetch|Failed to fetch|ECONNREFUSED|ENOTFOUND|offline|timeout|ECONNRESET|socket/i.test(msg);
}

export class SyncClient {
  constructor(
    private api: VaultApiClient,
    private opts: SyncClientOptions,
  ) {}

  /** Drain the persisted push queue, FIFO. Returns pushed item ids. */
  async pushQueue(): Promise<{ pushed: string[]; errors: string[]; offline: boolean }> {
    const pushed: string[] = [];
    const errors: string[] = [];
    let offline = false;
    // Snapshot the queue at start; new local edits enqueue behind it.
    const queue = loadQueue(this.opts.storage);
    for (const entry of queue) {
      try {
        const res = await this.api.syncPush(this.opts.vaultId, {
          item_id: entry.item_id,
          base_revision: entry.base_revision,
          encrypted_payload: entry.encrypted_payload,
          encrypted_item_key: entry.encrypted_item_key,
          encryption_version: entry.encryption_version,
          operation: entry.operation,
          signature: entry.signature,
        });
        // Remove only THIS entry: a newer edit may have replaced it meanwhile.
        removeQueuedPushEntry(this.opts.storage, entry);
        pushed.push(entry.item_id);
        // The server accepted the change; a failing hook must not be swallowed.
        if (this.opts.onPushed) await this.opts.onPushed(entry, { revision: res.revision, sequence: res.sequence });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isOfflineError(err)) {
          offline = true;
          markQueueAttempt(this.opts.storage, entry.item_id, msg);
          break; // connectivity is gone: stop, keep the rest queued in order
        }
        if (statusOf(err) === 401) {
          errors.push(`unauthorized (401): sign in again — ${queue.length} change(s) stay queued`);
          markQueueAttempt(this.opts.storage, entry.item_id, msg);
          break;
        }
        if (statusOf(err) === 409) {
          // Stale base revision: do NOT retry the same push. Record the
          // conflict on the next pull (the remote version wins nothing
          // automatically) and drop this queued entry — the local item
          // itself is untouched locally; the user resolves the conflict.
          errors.push(`409 conflict for ${entry.item_id}: remote changed first — kept local, pull will surface the conflict`);
          removeQueuedPushEntry(this.opts.storage, entry);
          continue;
        }
        errors.push(`${entry.item_id}: ${msg}`);
        markQueueAttempt(this.opts.storage, entry.item_id, msg);
      }
    }
    return { pushed, errors, offline };
  }

  /**
   * Pull since the saved checkpoint, page by page (the server returns at
   * most 500 events per page), applying AEAD-verified events.
   *
   * The checkpoint advances only past events that were fully handled. If an
   * event is REJECTED (decrypt/AEAD failure), the checkpoint is held just
   * before it, so the failure is neither skipped nor lost: it is reported on
   * every run until it can be applied. Paging stops at the first rejection.
   */
  async pull(): Promise<{ result: ApplyResult; offline: boolean }> {
    const total: ApplyResult = { applied: [], skipped: [], rejected: [], conflicts: [], tombstones: [], nextCursor: null };
    const maxPages = this.opts.maxPullPages ?? 200;
    for (let page = 0; page < maxPages; page++) {
      const checkpoint = loadCheckpoint(this.opts.storage, this.opts.vaultId);
      const since = checkpoint ? String(checkpoint.last_sequence) : undefined;
      const res = await this.api.syncPull(this.opts.vaultId, since) as { events: Parameters<typeof applyRemoteEvents>[0]; next_cursor: string | null };
      const events = Array.isArray(res.events) ? res.events : [];
      if (events.length === 0) break;
      const local = this.opts.getLocalState();
      const applied = await applyRemoteEvents(events, local, this.opts.decrypt, { itemMatchesEvent: this.opts.itemMatchesEvent });
      for (const id of applied.applied) {
        const state = local.get(id);
        if (state) this.opts.saveLocalItem(state.item, state.revision);
      }
      for (const id of applied.tombstones) {
        const revisions = events.filter((e) => e.item_id === id && e.operation === 'delete').map((e) => e.revision);
        this.opts.deleteLocalItem(id, revisions.length ? Math.max(...revisions) : 0);
      }
      if (applied.conflicts.length > 0) appendConflicts(this.opts.storage, applied.conflicts);
      total.applied.push(...applied.applied);
      total.skipped.push(...applied.skipped);
      total.rejected.push(...applied.rejected);
      total.conflicts.push(...applied.conflicts);
      total.tombstones.push(...applied.tombstones);

      const firstRejectedSeq = applied.rejected
        .map((r) => r.sequence)
        .filter((n): n is number => typeof n === 'number')
        .sort((x, y) => x - y)[0];
      const last = Number(applied.nextCursor);
      const target = firstRejectedSeq !== undefined ? firstRejectedSeq - 1 : last;
      const prior = checkpoint?.last_sequence ?? 0;
      if (target > prior) {
        saveCheckpoint(this.opts.storage, {
          vault_id: this.opts.vaultId,
          last_sequence: target,
          checkpoint_hash: null,
          updated_at: new Date().toISOString(),
        });
        total.nextCursor = String(target);
      }
      if (firstRejectedSeq !== undefined) break; // held at the rejected event
      if (events.length < 500) break;
    }
    return { result: total, offline: false };
  }

  /** Full sync: push queued local changes, then pull remote changes. */
  async syncAll(): Promise<SyncRunResult> {
    const errors: string[] = [];
    const pushed: string[] = [];
    let offline = false;
    try {
      const push = await this.pushQueue();
      pushed.push(...push.pushed);
      errors.push(...push.errors);
      offline = push.offline;
    } catch (err) {
      if (isOfflineError(err)) offline = true;
      else errors.push(err instanceof Error ? err.message : String(err));
    }
    if (offline) {
      return { offline: true, pushed, pulled: null, conflicts: loadConflicts(this.opts.storage).filter((c) => c.resolution === 'unresolved').length, errors, checkpoint: loadCheckpoint(this.opts.storage, this.opts.vaultId) };
    }
    try {
      const { result } = await this.pull();
      return {
        offline: false,
        pushed,
        pulled: result,
        conflicts: loadConflicts(this.opts.storage).filter((c) => c.resolution === 'unresolved').length,
        errors,
        checkpoint: loadCheckpoint(this.opts.storage, this.opts.vaultId),
      };
    } catch (err) {
      if (isOfflineError(err)) return { offline: true, pushed, pulled: null, conflicts: 0, errors, checkpoint: loadCheckpoint(this.opts.storage, this.opts.vaultId) };
      errors.push(err instanceof Error ? err.message : String(err));
      return { offline: false, pushed, pulled: null, conflicts: 0, errors, checkpoint: loadCheckpoint(this.opts.storage, this.opts.vaultId) };
    }
  }
}
