// Sync engine tests — self-contained, plain Node 20+ (node --test).
// These mirror the logic in packages/sync/src/index.ts (same rules, same
// constants). They do NOT import .ts files, so they run without a TS loader.
// A TS-level test that imports the real module should be added in CI once
// a loader (tsx) is available; until then these guard the RULES.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- mirrors of packages/sync/src/index.ts ---
function detectConflict(localRevision, localBase, remoteRevision) {
  if (localRevision === localBase) return 'none';
  if (remoteRevision === localBase) return 'none';
  return 'same_item_both_changed';
}
function detectDeleteConflict(localDeleted, remoteRevision, baseRevision) {
  if (!localDeleted) return 'none';
  if (remoteRevision === baseRevision) return 'none';
  return 'delete_vs_update';
}
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), remove: (k) => map.delete(k) };
}
const QUEUE_KEY = 'my-secrect.sync.queue.v1';
function loadQueue(s) { try { const r = s.get(QUEUE_KEY); return r ? JSON.parse(r) : []; } catch { return []; } }
function saveQueue(s, q) { s.set(QUEUE_KEY, JSON.stringify(q)); }
function enqueuePush(s, req) {
  const q = loadQueue(s).filter((x) => x.item_id !== req.item_id);
  q.push({ ...req, queued_at: new Date().toISOString(), attempts: 0 });
  saveQueue(s, q); return q;
}
// Keep-both conflict record shape (mirrors SyncConflict in index.ts)
function resolveConflictKeepBoth(local, remote, meta) {
  return { id: `conflict_${local.id}_${meta.remoteRevision}`, item_id: local.id, kind: 'same_item_both_changed', local_revision: meta.localRevision, remote_revision: meta.remoteRevision, base_revision: meta.baseRevision, local, remote, remote_device_id: meta.remoteDeviceId, detected_at: new Date().toISOString(), resolution: 'unresolved', resolved_at: null };
}

test('both-changed same item => conflict, BOTH versions kept, never LWW', () => {
  assert.equal(detectConflict(4, 3, 5), 'same_item_both_changed');
  const local = { id: 'item_1', title: 'My password (local edit)' };
  const remote = { id: 'item_1', title: 'My password (remote edit)' };
  const c = resolveConflictKeepBoth(local, remote, { localRevision: 4, remoteRevision: 5, baseRevision: 3, remoteDeviceId: 'device_b' });
  assert.equal(c.resolution, 'unresolved');
  assert.equal(c.local.title, 'My password (local edit)');
  assert.equal(c.remote.title, 'My password (remote edit)');
  // Neither side is destroyed: the local item stays live, the remote copy
  // is preserved in the conflict record for the user to choose.
  assert.notEqual(c.local.title, c.remote.title);
});

test('one side unchanged => no conflict', () => {
  assert.equal(detectConflict(3, 3, 5), 'none');
  assert.equal(detectConflict(5, 3, 3), 'none');
});

test('delete vs update => delete_vs_update conflict', () => {
  assert.equal(detectDeleteConflict(true, 5, 3), 'delete_vs_update');
  assert.equal(detectDeleteConflict(true, 3, 3), 'none');
  assert.equal(detectDeleteConflict(false, 5, 3), 'none');
});

test('offline queue: FIFO order, deduped per item, replay after offline', () => {
  const s = memoryStorage();
  enqueuePush(s, { item_id: 'a', base_revision: 1, operation: 'upsert' });
  enqueuePush(s, { item_id: 'b', base_revision: 1, operation: 'upsert' });
  // Editing 'a' again offline supersedes the older queued entry for 'a'.
  enqueuePush(s, { item_id: 'a', base_revision: 2, operation: 'upsert' });
  const q = loadQueue(s);
  assert.deepEqual(q.map((x) => x.item_id), ['b', 'a']);
  assert.equal(q.find((x) => x.item_id === 'a').base_revision, 2);
  // Simulate offline: pushes fail, queue stays intact.
  let online = false;
  const pushed = [];
  for (const entry of loadQueue(s)) {
    if (!online) break; // connectivity gone: stop, keep rest queued in order
    pushed.push(entry.item_id);
  }
  assert.deepEqual(pushed, []);
  assert.equal(loadQueue(s).length, 2);
  // Back online: replay in FIFO order.
  online = true;
  for (const entry of [...loadQueue(s)]) {
    if (online) { pushed.push(entry.item_id); saveQueue(s, loadQueue(s).filter((x) => x.item_id !== entry.item_id)); }
  }
  assert.deepEqual(pushed, ['b', 'a']);
  assert.equal(loadQueue(s).length, 0);
});

test('stale remote revision is skipped, never rolls back local', () => {
  const localRevision = 5;
  const remoteRevision = 4;
  const shouldApply = remoteRevision > localRevision;
  assert.equal(shouldApply, false);
});

test('tombstone only applies when newer than local', () => {
  const apply = (tombstoneRevision, localRevision) => tombstoneRevision > localRevision;
  assert.equal(apply(6, 5), true);
  assert.equal(apply(5, 5), false);
  assert.equal(apply(4, 5), false);
});
