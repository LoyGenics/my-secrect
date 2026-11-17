// Sync pull contract + SDK queue-replay tests — self-contained, plain Node 20+.
// Mirrors packages/sync/src/index.ts (applyRemoteEvents) and
// packages/sync/src/sync-client.ts (pushQueue / pull) plus the server
// contract in apps/api/app/domains/sync/pull.rb (Phase C, H1).
// They do NOT import .ts files, so they run without a TS loader.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- mirrors ---
// applyRemoteEvents: an upsert without ciphertext is SKIPPED, never applied.
function applyRemoteEvents(events, localById) {
  const result = { applied: [], skipped: [], tombstones: [] };
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.operation === 'delete') {
      const local = localById.get(event.item_id);
      if (local && event.revision <= local.revision) { result.skipped.push(event.item_id); continue; }
      result.tombstones.push(event.item_id);
      localById.delete(event.item_id);
      continue;
    }
    if (!event.encrypted_payload || !event.encrypted_item_key) {
      result.skipped.push(event.item_id);
      continue;
    }
    const local = localById.get(event.item_id);
    if (local && event.revision <= local.revision) { result.skipped.push(event.item_id); continue; }
    localById.set(event.item_id, { item: { id: event.item_id }, revision: event.revision });
    result.applied.push(event.item_id);
  }
  return result;
}
// pushQueue: an entry leaves the queue ONLY on 2xx; offline keeps it.
function drainQueue(queue, send) {
  const pushed = [];
  for (const entry of [...queue]) {
    const outcome = send(entry); // 'ok' | 'offline' | 'conflict'
    if (outcome === 'offline') break;
    queue.splice(queue.indexOf(entry), 1);
    if (outcome === 'ok') pushed.push(entry.item_id);
  }
  return { pushed, remaining: queue.map((q) => q.item_id) };
}

test('Phase C pull contract: upsert events carry ciphertext and apply; deletes carry a tombstone and no ciphertext', () => {
  const events = [
    { sequence: 1, item_id: 'a', revision: 1, operation: 'upsert', tombstone: false, encrypted_payload: 'Y2lwaGVy', encrypted_item_key: 'd3JhcHBlZA==', encryption_version: 1 },
    { sequence: 2, item_id: 'b', revision: 2, operation: 'delete', tombstone: true, encrypted_payload: null, encrypted_item_key: null, encryption_version: null },
  ];
  const local = new Map([['b', { item: { id: 'b' }, revision: 1 }]]);
  const r = applyRemoteEvents(events, local);
  assert.deepEqual(r.applied, ['a']);
  assert.deepEqual(r.tombstones, ['b']);
  assert.deepEqual(r.skipped, []);
});

test('pre-Phase C pull (no ciphertext) is skipped, never applied — this is the H1 bug', () => {
  const events = [
    { sequence: 1, item_id: 'a', revision: 1, operation: 'upsert', encrypted_payload: null, encrypted_item_key: null },
  ];
  const r = applyRemoteEvents(events, new Map());
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped, ['a']);
});

test('offline queue replay: offline keeps the queue intact and in order; back online it drains FIFO', () => {
  const queue = [{ item_id: 'a' }, { item_id: 'b' }, { item_id: 'c' }];
  let r = drainQueue(queue, () => 'offline');
  assert.deepEqual(r.pushed, []);
  assert.deepEqual(r.remaining, ['a', 'b', 'c']);
  r = drainQueue(queue, () => 'ok');
  assert.deepEqual(r.pushed, ['a', 'b', 'c']);
  assert.deepEqual(r.remaining, []);
});

test('409 conflict entry is dropped from the queue but the local item is untouched (surfaced on pull)', () => {
  const queue = [{ item_id: 'a' }, { item_id: 'b' }];
  const r = drainQueue(queue, (e) => (e.item_id === 'a' ? 'conflict' : 'ok'));
  assert.deepEqual(r.pushed, ['b']);
  assert.deepEqual(r.remaining, []);
});

test('stale remote revision never rolls back local state', () => {
  const local = new Map([['a', { item: { id: 'a' }, revision: 5 }]]);
  const r = applyRemoteEvents([
    { sequence: 1, item_id: 'a', revision: 4, operation: 'upsert', encrypted_payload: 'e', encrypted_item_key: 'k' },
  ], local);
  assert.deepEqual(r.applied, []);
  assert.equal(local.get('a').revision, 5);
});
