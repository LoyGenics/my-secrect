// Real SyncClient against a scripted API double. These tests pin SyncClient's
// own queue / status / checkpoint rules. They make NO crypto or server-side
// security claim (the two-client test in tests/sync-e2e covers the real stack).
// Run: npx tsx --test packages/sync/tests/sync-client-queue.import.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/sync-client.ts';
import { enqueuePush, loadCheckpoint, loadQueue, memorySyncStorage } from '../src/index.ts';

const VAULT_WITH_409 = 'a409b409-0000-4000-8000-000000000500'; // digits "409"/"500" in the path

function push(itemId: string, payload: string, base = 0) {
  return { vault_id: 'v', item_id: itemId, base_revision: base, encrypted_payload: payload, encrypted_item_key: 'k', encryption_version: 1, operation: 'upsert' as const };
}
function client(api: any, storage = memorySyncStorage(), extra: Record<string, unknown> = {}) {
  const c = new SyncClient(api, {
    vaultId: VAULT_WITH_409, deviceId: 'dev', storage,
    decrypt: async () => { throw new Error('boom'); },
    getLocalState: () => new Map(), saveLocalItem: () => {}, deleteLocalItem: () => {},
    ...extra,
  } as any);
  return { c, storage };
}
const apiErr = (status: number, path: string) => Object.assign(new Error(`API ${status} ${path}`), { status });

test('a 500 whose path contains "409" is NOT treated as a 409 conflict: entry stays queued', async () => {
  const storage = memorySyncStorage();
  enqueuePush(storage, push('i1', 'p1'));
  const { c } = client({ syncPush: async () => { throw apiErr(500, `/v1/vaults/${VAULT_WITH_409}/sync/push`); } }, storage);
  const r = await c.pushQueue();
  assert.equal(loadQueue(storage).length, 1, 'entry must survive a 500');
  assert.equal(r.offline, false);
  assert.match(r.errors[0], /500/);
});

test('a real 409 drops the stale entry and reports it; local data is the caller\'s row (untouched)', async () => {
  const storage = memorySyncStorage();
  enqueuePush(storage, push('i1', 'p1'));
  const { c } = client({ syncPush: async () => { throw apiErr(409, '/x'); } }, storage);
  const r = await c.pushQueue();
  assert.equal(loadQueue(storage).length, 0);
  assert.match(r.errors[0], /409 conflict/);
});

test('an edit queued while a push is in flight is NOT removed by the older push succeeding', async () => {
  const storage = memorySyncStorage();
  enqueuePush(storage, push('i1', 'old'));
  const { c } = client({
    syncPush: async () => { enqueuePush(storage, push('i1', 'newer')); return { item_id: 'i1', revision: 1, sequence: 1 }; },
  }, storage);
  await c.pushQueue();
  const q = loadQueue(storage);
  assert.equal(q.length, 1);
  assert.equal(q[0].encrypted_payload, 'newer');
});

test('onPushed receives the server revision; an error thrown there is reported, not swallowed', async () => {
  const storage = memorySyncStorage();
  enqueuePush(storage, push('i1', 'p'));
  const seen: number[] = [];
  const { c } = client({ syncPush: async () => ({ item_id: 'i1', revision: 7, sequence: 3 }) }, storage, {
    onPushed: async (_e: unknown, res: { revision: number }) => { seen.push(res.revision); throw new Error('hook failed'); },
  });
  const r = await c.pushQueue();
  assert.deepEqual(seen, [7]);
  assert.ok(r.errors.some((e) => /hook failed/.test(e)));
});

test('network failure keeps the queue and reports offline; 401 stops and reports', async () => {
  const storage = memorySyncStorage();
  enqueuePush(storage, push('i1', 'p'));
  let { c } = client({ syncPush: async () => { throw new TypeError('fetch failed'); } }, storage);
  assert.equal((await c.pushQueue()).offline, true);
  assert.equal(loadQueue(storage).length, 1);
  ({ c } = client({ syncPush: async () => { throw apiErr(401, '/x'); } }, storage));
  const r = await c.pushQueue();
  assert.equal(r.offline, false);
  assert.match(r.errors[0], /401/);
  assert.equal(loadQueue(storage).length, 1);
});

test('a rejected (undecryptable) event holds the checkpoint before it and is reported every run', async () => {
  const storage = memorySyncStorage();
  const ev = (seq: number, item: string) => ({ id: `e${seq}`, vault_id: 'v', sequence: seq, item_id: item, revision: 1, operation: 'upsert', device_id: 'd', signature: '', created_at: 'now', encrypted_payload: 'x', encrypted_item_key: 'y', encryption_version: 1 });
  const events = [ev(1, 'a'), ev(2, 'b')];
  const { c } = client({ syncPull: async (_v: string, since?: string) => ({ events: events.filter((e) => e.sequence > Number(since ?? 0)), next_cursor: '2' }) }, storage);
  const r1 = await c.pull();
  assert.equal(r1.result.rejected.length, 2);
  assert.equal(loadCheckpoint(storage, VAULT_WITH_409), null, 'checkpoint must not advance past a rejected event');
  const r2 = await c.pull();
  assert.equal(r2.result.rejected.length, 2, 'still reported on the next run');
});

test('pull pages through >500 events', async () => {
  const storage = memorySyncStorage();
  const mk = (seq: number) => ({ id: `e${seq}`, vault_id: 'v', sequence: seq, item_id: `i${seq}`, revision: 1, operation: 'delete', tombstone: true, device_id: 'd', signature: '', created_at: 'now' });
  const all = Array.from({ length: 620 }, (_, i) => mk(i + 1));
  const deleted: Array<[string, number]> = [];
  const { c } = client({
    syncPull: async (_v: string, since?: string) => ({ events: all.filter((e) => e.sequence > Number(since ?? 0)).slice(0, 500), next_cursor: null }),
  }, storage, { deleteLocalItem: (id: string, rev: number) => deleted.push([id, rev]) });
  await c.pull();
  assert.equal(deleted.length, 620);
  assert.equal(deleted[0][1], 1, 'tombstone revision is the delete event revision');
  assert.equal(loadCheckpoint(storage, VAULT_WITH_409)?.last_sequence, 620);
});
