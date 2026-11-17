/**
 * `StorageBackend` on the Tauri SQLCipher store (src-tauri/src/store.rs).
 *
 * The vault's storage contract is synchronous (`getItem` returns a value)
 * while Tauri IPC is asynchronous, so this backend is a write-behind cache:
 *
 * - construction reads the whole store ONCE, synchronously (see
 *   `KvTransport.loadSnapshotSync`), before the vault is first used;
 * - `getItem` answers from that cache;
 * - `setItem` / `removeItem` update the cache and queue the change; every
 *   change made in the same synchronous JS task is sent as ONE batch and
 *   committed in ONE SQLite transaction (all or nothing), so e.g.
 *   writing the wrapped keys and the rows together is atomic;
 * - batches are committed strictly in order, each guarded by the store
 *   generation it was based on (compare-and-swap): a stale writer is
 *   rejected instead of overwriting newer data.
 *
 * Fail closed: if loading or any commit fails, the backend enters a failed
 * state — `onFailure` is told once, and every later get/set/remove throws
 * `StorageUnavailableError`. It never falls back to localStorage.
 */

/** Same contract as `StorageBackend` in `../vault.ts` (structurally identical). */
export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KvSnapshot {
  generation: number;
  entries: Record<string, string>;
}

export type KvOp = { op: 'set'; key: string; value: string } | { op: 'remove'; key: string };

/** IPC boundary to the Rust store. */
export interface KvTransport {
  /** Whole store, read synchronously (startup hydration only). */
  loadSnapshotSync(): KvSnapshot;
  /** Whole store, read fresh from the encrypted database. */
  readSnapshot(): Promise<KvSnapshot>;
  /** Apply `ops` atomically iff the store is at `expectedGeneration`; resolves the new generation. */
  commit(expectedGeneration: number, ops: KvOp[]): Promise<number>;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** Same limit as the CHECK constraint in store.rs (UTF-8 bytes). */
export const MAX_KEY_BYTES = 512;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function toUnavailable(context: string, err: unknown): StorageUnavailableError {
  if (err instanceof StorageUnavailableError) return err;
  return new StorageUnavailableError(`${context}: ${errorMessage(err)}`);
}

/** Validate a snapshot crossing the IPC boundary. */
export function parseSnapshot(value: unknown): KvSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('snapshot is not an object');
  const { generation, entries } = value as { generation?: unknown; entries?: unknown };
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('snapshot has an invalid generation');
  }
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('snapshot has invalid entries');
  }
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v !== 'string') throw new Error(`snapshot value for ${k} is not a string`);
    out[k] = v;
  }
  return { generation, entries: out };
}

function checkKey(key: string): void {
  const bytes = new TextEncoder().encode(key).length;
  if (bytes === 0 || bytes > MAX_KEY_BYTES) {
    throw new RangeError(`storage key must be 1-${MAX_KEY_BYTES} UTF-8 bytes`);
  }
}

export class TauriSqlcipherBackend implements StorageBackend {
  private readonly cache: Map<string, string>;
  private generation: number;
  private pending = new Map<string, string | null>();
  private flushQueued = false;
  private chain: Promise<void> = Promise.resolve();
  private failed: StorageUnavailableError | null = null;

  /** Throws `StorageUnavailableError` if the store cannot be read. */
  constructor(
    private readonly transport: KvTransport,
    private readonly onFailure: (error: StorageUnavailableError) => void = () => undefined,
  ) {
    let snapshot: KvSnapshot;
    try {
      snapshot = transport.loadSnapshotSync();
    } catch (err) {
      throw toUnavailable('could not open the encrypted vault store', err);
    }
    this.cache = new Map(Object.entries(snapshot.entries));
    this.generation = snapshot.generation;
  }

  /** The error that put the backend in the failed state, if any. */
  get failure(): StorageUnavailableError | null {
    return this.failed;
  }

  getItem(key: string): string | null {
    this.assertUsable();
    const value = this.cache.get(String(key));
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.assertUsable();
    const k = String(key);
    checkKey(k);
    const v = String(value);
    this.cache.set(k, v);
    this.pending.set(k, v);
    this.queueFlush();
  }

  removeItem(key: string): void {
    this.assertUsable();
    const k = String(key);
    checkKey(k);
    this.cache.delete(k);
    this.pending.set(k, null);
    this.queueFlush();
  }

  /** Resolves once every change made so far is committed; rejects if the backend failed. */
  flush(): Promise<void> {
    return this.afterPendingWrites(async () => undefined);
  }

  /**
   * Run `task` after every change made so far is committed and before any
   * later change is sent. Rejects (without running `task`) if a commit failed.
   */
  afterPendingWrites<T>(task: () => Promise<T>): Promise<T> {
    this.drainPending();
    const run = this.chain.then(() => {
      if (this.failed) throw this.failed;
      return task();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read the store straight from the encrypted database (bypasses the cache). */
  readCommitted(): Promise<KvSnapshot> {
    return this.transport.readSnapshot();
  }

  /** Enter the failed state (idempotent). */
  fail(error: StorageUnavailableError): void {
    if (this.failed) return;
    this.failed = error;
    this.pending.clear();
    this.onFailure(error);
  }

  private assertUsable(): void {
    if (this.failed) throw this.failed;
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.drainPending();
    });
  }

  private drainPending(): void {
    if (this.pending.size === 0) return;
    const ops: KvOp[] = [];
    for (const [key, value] of this.pending) {
      ops.push(value === null ? { op: 'remove', key } : { op: 'set', key, value });
    }
    this.pending = new Map();
    this.chain = this.chain.then(() => this.commit(ops));
  }

  private async commit(ops: KvOp[]): Promise<void> {
    if (this.failed) return;
    try {
      const next = await this.transport.commit(this.generation, ops);
      if (!Number.isSafeInteger(next) || next <= this.generation) {
        throw new Error(`store returned an invalid generation (${String(next)})`);
      }
      this.generation = next;
    } catch (err) {
      this.fail(toUnavailable('saving to the encrypted vault store failed; the last change was NOT saved', err));
    }
  }
}
