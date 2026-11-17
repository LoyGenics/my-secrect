/**
 * Real-module tests for apps/desktop/src/storage (backend selection, the
 * write-behind SQLCipher backend, and the localStorage -> SQLCipher
 * migration). Run: npx tsx --test apps/desktop/storage-backend.test.ts
 *
 * What is real: TauriSqlcipherBackend, startLegacyMigration,
 * selectStorageBackend. What is a stand-in: the two boundaries — the Rust
 * store behind Tauri IPC (`FakeRustStore`, same rules as store.rs:
 * generation compare-and-swap, all-or-nothing batches, 1..512-byte keys) and
 * localStorage (`MemoryLocalStorage`). The Rust store itself is covered by
 * `cargo test` in src-tauri, the IPC path by the e2e harness
 * (src-tauri/tests/e2e_app.rs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTauriRuntime,
  selectStorageBackend,
  startLegacyMigration,
  StorageUnavailableError,
  TauriSqlcipherBackend,
  type KvOp,
  type KvSnapshot,
  type KvTransport,
  type MigrationReport,
  type StorageBackend,
  type StorageRuntime,
} from './src/storage/index';

const ROWS = 'my-secrect.local-vault.v1';
const KEYS = 'my-secrect.local-vault.v1.keys';
const VAULT_KEYS = [ROWS, KEYS] as const;

class FakeRustStore implements KvTransport {
  generation = 0;
  entries = new Map<string, string>();
  commits: KvOp[][] = [];
  failLoad: string | null = null;
  failNextCommit: string | null = null;
  /** Simulates a corrupted read-back. */
  tamperRead: ((s: KvSnapshot) => KvSnapshot) | null = null;

  constructor(initial: Record<string, string> = {}, generation = 0) {
    for (const [k, v] of Object.entries(initial)) this.entries.set(k, v);
    this.generation = generation;
  }

  private snap(): KvSnapshot {
    return { generation: this.generation, entries: Object.fromEntries(this.entries) };
  }

  loadSnapshotSync(): KvSnapshot {
    if (this.failLoad) throw new Error(this.failLoad);
    return this.snap();
  }

  async readSnapshot(): Promise<KvSnapshot> {
    const s = this.snap();
    return this.tamperRead ? this.tamperRead(s) : s;
  }

  async commit(expected: number, ops: KvOp[]): Promise<number> {
    await Promise.resolve();
    if (this.failNextCommit) {
      const msg = this.failNextCommit;
      this.failNextCommit = null;
      throw msg; // Tauri rejects with the Rust error string
    }
    if (expected !== this.generation) {
      throw `write rejected: the vault changed elsewhere (expected generation ${expected}, store is at ${this.generation})`;
    }
    const next = new Map(this.entries);
    for (const op of ops) {
      const len = new TextEncoder().encode(op.key).length;
      if (len < 1 || len > 512) throw 'CHECK constraint failed: key';
      if (op.op === 'set') next.set(op.key, op.value);
      else next.delete(op.key);
    }
    this.entries = next;
    this.commits.push(ops);
    this.generation += 1;
    return this.generation;
  }
}

class MemoryLocalStorage implements StorageBackend {
  data = new Map<string, string>();
  failRemove = false;
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.data.set(k, v);
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failRemove) throw new Error('SecurityError: storage is blocked');
    this.data.delete(key);
  }
}

function runtimeFor(store: FakeRustStore, inTauri = true) {
  const fatal: StorageUnavailableError[] = [];
  let resolveMigration!: (r: MigrationReport) => void;
  const migration = new Promise<MigrationReport>((r) => (resolveMigration = r));
  let transportCreated = 0;
  const runtime: StorageRuntime = {
    isTauri: () => inTauri,
    transport: () => {
      transportCreated += 1;
      return store;
    },
    reportFatal: (e) => fatal.push(e),
    migrationFinished: (r) => resolveMigration(r),
  };
  return { runtime, fatal, migration, transportCreated: () => transportCreated };
}

// ---------- selection ----------

test('isTauriRuntime: false in a plain JS runtime, true with the official flag or __TAURI_INTERNALS__', () => {
  const g = globalThis as { isTauri?: unknown; window?: unknown };
  assert.equal(isTauriRuntime(), false);
  try {
    g.isTauri = true; // set by Tauri's init script; read by @tauri-apps/api isTauri()
    assert.equal(isTauriRuntime(), true);
    delete g.isTauri;
    g.window = { __TAURI_INTERNALS__: {} };
    assert.equal(isTauriRuntime(), true);
  } finally {
    delete g.isTauri;
    delete g.window;
  }
  assert.equal(isTauriRuntime(), false);
});

test('outside Tauri: returns the existing localStorage backend, never touches the store', () => {
  const store = new FakeRustStore();
  const { runtime, transportCreated } = runtimeFor(store, false);
  const legacy = new MemoryLocalStorage();
  let calls = 0;
  const backend = selectStorageBackend(
    { fallback: () => (calls++, legacy), migrateKeys: VAULT_KEYS },
    runtime,
  );
  assert.equal(backend, legacy);
  assert.equal(calls, 1);
  assert.equal(transportCreated(), 0);
});

test('inside Tauri: returns the SQLCipher backend, hydrated synchronously', () => {
  const store = new FakeRustStore({ [KEYS]: '{"salt":"x"}' }, 4);
  const { runtime } = runtimeFor(store);
  const legacy = new MemoryLocalStorage();
  const backend = selectStorageBackend({ fallback: () => legacy, migrateKeys: VAULT_KEYS }, runtime);
  assert.ok(backend instanceof TauriSqlcipherBackend);
  assert.notEqual(backend, legacy);
  // Synchronous, before any await: what the vault's first render needs.
  assert.equal(backend.getItem(KEYS), '{"salt":"x"}');
  assert.equal(backend.getItem(ROWS), null);
});

test('inside Tauri: store unavailable (e.g. keychain denied) fails closed, no localStorage fallback', () => {
  const store = new FakeRustStore();
  store.failLoad = 'vault database key unavailable: could not read the database key from the OS credential store';
  const { runtime, fatal } = runtimeFor(store);
  const legacy = new MemoryLocalStorage({ [KEYS]: 'k' });
  assert.throws(
    () => selectStorageBackend({ fallback: () => legacy, migrateKeys: VAULT_KEYS }, runtime),
    (e: unknown) => e instanceof StorageUnavailableError && /OS credential store/.test(e.message),
  );
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /could not open the encrypted vault store/);
  assert.equal(legacy.getItem(KEYS), 'k', 'localStorage must be left alone');
});

// ---------- backend semantics ----------

test('writes in one synchronous task are committed as one atomic batch, in order', async () => {
  const store = new FakeRustStore({ old: 'x' });
  const backend = new TauriSqlcipherBackend(store);
  backend.setItem(KEYS, 'k1');
  backend.setItem(ROWS, '[]');
  backend.removeItem('old');
  backend.setItem(KEYS, 'k2'); // last write to a key wins inside a batch
  assert.equal(backend.getItem(KEYS), 'k2');
  assert.equal(store.commits.length, 0, 'nothing is sent synchronously');
  await backend.flush();
  assert.equal(store.commits.length, 1);
  assert.deepEqual(store.commits[0], [
    { op: 'set', key: KEYS, value: 'k2' },
    { op: 'set', key: ROWS, value: '[]' },
    { op: 'remove', key: 'old' },
  ]);
  assert.equal(store.generation, 1);

  backend.setItem(ROWS, '[1]');
  await Promise.resolve();
  backend.setItem(ROWS, '[1,2]'); // later task -> separate batch, sent after the first
  await backend.flush();
  assert.equal(store.commits.length, 3);
  assert.equal(store.entries.get(ROWS), '[1,2]');
  assert.equal(store.generation, 3);
});

test('a failed commit puts the backend in a failed state and reports it once', async () => {
  const store = new FakeRustStore();
  const fatal: StorageUnavailableError[] = [];
  const backend = new TauriSqlcipherBackend(store, (e) => fatal.push(e));
  store.failNextCommit = 'vault storage I/O error: disk full';
  backend.setItem(ROWS, '[1]');
  await assert.rejects(backend.flush(), /the last change was NOT saved: vault storage I\/O error: disk full/);
  assert.equal(fatal.length, 1);
  assert.equal(store.entries.size, 0);
  assert.throws(() => backend.getItem(ROWS), StorageUnavailableError);
  assert.throws(() => backend.setItem(ROWS, '[2]'), StorageUnavailableError);
  assert.throws(() => backend.removeItem(ROWS), StorageUnavailableError);
  assert.equal(store.commits.length, 0);
  assert.equal(fatal.length, 1);
});

test('a stale writer (store changed elsewhere) is rejected, not merged', async () => {
  const store = new FakeRustStore({ [ROWS]: '[]' });
  const fatal: StorageUnavailableError[] = [];
  const backend = new TauriSqlcipherBackend(store, (e) => fatal.push(e));
  // Another window/instance commits after our snapshot.
  await store.commit(0, [{ op: 'set', key: ROWS, value: '["newer"]' }]);
  backend.setItem(ROWS, '["stale"]');
  await assert.rejects(backend.flush(), /vault changed elsewhere/);
  assert.equal(store.entries.get(ROWS), '["newer"]');
  assert.equal(fatal.length, 1);
});

test('invalid keys are refused synchronously at the call site', () => {
  const backend = new TauriSqlcipherBackend(new FakeRustStore());
  assert.throws(() => backend.setItem('', 'v'), RangeError);
  assert.throws(() => backend.setItem('k'.repeat(513), 'v'), RangeError);
  assert.throws(() => backend.setItem('é'.repeat(257), 'v'), RangeError); // 514 UTF-8 bytes
  backend.setItem('k'.repeat(512), 'v');
});

// ---------- migration ----------

test('migration: copies, commits, verifies from the database, then removes localStorage keys', async () => {
  const store = new FakeRustStore();
  const legacy = new MemoryLocalStorage({ [ROWS]: '[{"id":"a"}]', [KEYS]: '{"salt":"s"}', theme: 'dark' });
  const { runtime, migration, fatal } = runtimeFor(store);
  const backend = selectStorageBackend({ fallback: () => legacy, migrateKeys: VAULT_KEYS }, runtime);
  // First render (synchronous) already sees the vault.
  assert.equal(backend.getItem(KEYS), '{"salt":"s"}');
  assert.equal(backend.getItem(ROWS), '[{"id":"a"}]');
  assert.equal(legacy.getItem(KEYS), '{"salt":"s"}', 'not removed before verification');

  assert.deepEqual(await migration, { status: 'migrated', keys: [ROWS, KEYS] });
  assert.equal(store.commits.length, 1, 'both keys in one transaction');
  assert.equal(store.entries.get(ROWS), '[{"id":"a"}]');
  assert.equal(store.entries.get(KEYS), '{"salt":"s"}');
  assert.equal(legacy.getItem(ROWS), null);
  assert.equal(legacy.getItem(KEYS), null);
  assert.equal(legacy.getItem('theme'), 'dark', 'non-vault keys are not touched');
  assert.equal(fatal.length, 0);

  // Second launch: nothing left to migrate.
  const second = runtimeFor(store);
  const again = selectStorageBackend({ fallback: () => legacy, migrateKeys: VAULT_KEYS }, second.runtime);
  assert.deepEqual(await second.migration, { status: 'none' });
  assert.equal(again.getItem(KEYS), '{"salt":"s"}');
});

test('migration: commit failure keeps the localStorage copy and fails closed', async () => {
  const store = new FakeRustStore();
  store.failNextCommit = 'vault database error: database is locked';
  const legacy = new MemoryLocalStorage({ [ROWS]: '[]', [KEYS]: 'k' });
  const { runtime, migration, fatal } = runtimeFor(store);
  const backend = selectStorageBackend({ fallback: () => legacy, migrateKeys: VAULT_KEYS }, runtime);
  const report = await migration;
  assert.equal(report.status, 'failed');
  assert.match((report as { error: string }).error, /database is locked/);
  assert.equal(legacy.getItem(ROWS), '[]');
  assert.equal(legacy.getItem(KEYS), 'k');
  assert.equal(store.entries.size, 0);
  assert.equal(fatal.length, 1);
  assert.throws(() => backend.getItem(KEYS), StorageUnavailableError);

  // Next launch retries and succeeds.
  const retry = runtimeFor(store);
  selectStorageBackend({ fallback: () => legacy, migrateKeys: VAULT_KEYS }, retry.runtime);
  assert.equal((await retry.migration).status, 'migrated');
  assert.equal(store.entries.get(KEYS), 'k');
  assert.equal(legacy.getItem(KEYS), null);
});

test('migration: a read-back mismatch keeps the localStorage copy and fails closed', async () => {
  const store = new FakeRustStore();
  store.tamperRead = (s) => ({ ...s, entries: { ...s.entries, [ROWS]: 'corrupted' } });
  const legacy = new MemoryLocalStorage({ [ROWS]: '[]', [KEYS]: 'k' });
  const fatal: StorageUnavailableError[] = [];
  const backend = new TauriSqlcipherBackend(store, (e) => fatal.push(e));
  const report = await startLegacyMigration(legacy, backend, VAULT_KEYS);
  assert.equal(report.status, 'failed');
  assert.equal(legacy.getItem(ROWS), '[]');
  assert.equal(legacy.getItem(KEYS), 'k');
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /does not match localStorage/);
});

test('migration: store already holds a different vault -> conflict, nothing copied or deleted', async () => {
  const store = new FakeRustStore({ [KEYS]: 'vault-A-keys' }, 2);
  const legacy = new MemoryLocalStorage({ [ROWS]: 'vault-B-rows', [KEYS]: 'vault-B-keys' });
  const backend = new TauriSqlcipherBackend(store);
  const report = await startLegacyMigration(legacy, backend, VAULT_KEYS);
  assert.deepEqual(report, { status: 'conflict', keys: [ROWS, KEYS] });
  assert.equal(backend.getItem(ROWS), null, 'B rows must not be spliced next to A keys');
  assert.equal(backend.getItem(KEYS), 'vault-A-keys');
  await backend.flush();
  assert.equal(store.commits.length, 0);
  assert.equal(legacy.getItem(ROWS), 'vault-B-rows');
  assert.equal(legacy.getItem(KEYS), 'vault-B-keys');
});

test('migration: store-only key + a key to copy is a conflict too', async () => {
  const store = new FakeRustStore({ [KEYS]: 'vault-A-keys' });
  const legacy = new MemoryLocalStorage({ [ROWS]: 'vault-B-rows' });
  const backend = new TauriSqlcipherBackend(store);
  assert.equal((await startLegacyMigration(legacy, backend, VAULT_KEYS)).status, 'conflict');
  assert.equal(backend.getItem(ROWS), null);
  assert.equal(legacy.getItem(ROWS), 'vault-B-rows');
});

test('migration: finishes an interrupted cleanup (identical copy already in the store)', async () => {
  const store = new FakeRustStore({ [ROWS]: '[]', [KEYS]: 'k' }, 1);
  const legacy = new MemoryLocalStorage({ [ROWS]: '[]' }); // KEYS already removed last time
  const backend = new TauriSqlcipherBackend(store);
  assert.deepEqual(await startLegacyMigration(legacy, backend, VAULT_KEYS), { status: 'migrated', keys: [ROWS] });
  assert.equal(store.commits.length, 0, 'nothing to rewrite');
  assert.equal(legacy.getItem(ROWS), null);
});

test('migration: localStorage removal failure is reported; data stays in both places', async () => {
  const store = new FakeRustStore();
  const legacy = new MemoryLocalStorage({ [ROWS]: '[]', [KEYS]: 'k' });
  legacy.failRemove = true;
  const backend = new TauriSqlcipherBackend(store);
  const report = await startLegacyMigration(legacy, backend, VAULT_KEYS);
  assert.equal(report.status, 'cleanup-incomplete');
  assert.equal(store.entries.get(KEYS), 'k');
  assert.equal(legacy.getItem(KEYS), 'k');
  assert.equal(backend.failure, null, 'the store itself is healthy');
});

test('migration: later writes wait until verification has read the database', async () => {
  const store = new FakeRustStore();
  const legacy = new MemoryLocalStorage({ [ROWS]: '[]', [KEYS]: 'k' });
  const backend = new TauriSqlcipherBackend(store);
  const migration = startLegacyMigration(legacy, backend, VAULT_KEYS);
  backend.setItem(ROWS, '[{"id":"new"}]'); // user edit right after startup
  assert.equal((await migration).status, 'migrated');
  await backend.flush();
  assert.equal(store.entries.get(ROWS), '[{"id":"new"}]');
  assert.equal(store.commits.length, 2);
});
