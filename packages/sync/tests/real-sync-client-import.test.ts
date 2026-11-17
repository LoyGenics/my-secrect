// Imports the real sync engine. Do not reimplement applyRemoteEvents here.
// Run: node --experimental-strip-types --test packages/sync/tests/real-sync-client-import.test.ts
// The signature field is an opaque string. This suite does not treat it as authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemoteEvents } from '../src/index.ts';

function item(id, title, updatedAt) {
  return {
    id,
    type: 'secure_note',
    schema_version: 1,
    title,
    fields: { notes: title },
    tags: [],
    relations: [],
    attachments: [],
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: updatedAt,
  };
}

function upsert(overrides) {
  return {
    id: 'evt_1',
    vault_id: 'vault_1',
    sequence: 1,
    item_id: 'item_1',
    revision: 1,
    operation: 'upsert',
    device_id: 'device_b',
    signature: 'opaque-not-authenticated',
    created_at: '2026-11-17T01:00:00.000Z',
    encrypted_payload: 'ciphertext',
    encrypted_item_key: 'wrapped-key',
    encryption_version: 1,
    ...overrides,
  };
}

test('remote upsert with a newer revision is applied', async () => {
  const localItem = item('item_1', 'local note', '2026-11-17T00:00:00.000Z');
  const remoteItem = item('item_1', 'remote note', '2026-11-17T02:00:00.000Z');
  const local = new Map([
    ['item_1', { item: localItem, revision: 2, baseRevision: 2 }],
  ]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 3, sequence: 8 })],
    local,
    async () => remoteItem,
  );

  assert.deepEqual(result.applied, ['item_1']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.tombstones, []);
  const state = local.get('item_1');
  assert.equal(state.item, remoteItem);
  assert.equal(state.item.title, 'remote note');
  assert.equal(state.revision, 3);
  assert.equal(state.baseRevision, 3);
});

test('stale revision is not applied', async () => {
  const localItem = item('item_1', 'current note', '2026-11-17T03:00:00.000Z');
  const state = { item: localItem, revision: 5, baseRevision: 5 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 4, sequence: 3 })],
    local,
    async () => item('item_1', 'stale remote', '2026-11-17T01:00:00.000Z'),
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.tombstones, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].item_id, 'item_1');
  assert.match(result.skipped[0].reason, /stale/i);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').item.title, 'current note');
  assert.equal(local.get('item_1').revision, 5);
  assert.equal(local.get('item_1').baseRevision, 5);
});

test('decrypted id mismatch is rejected and does not overwrite the local item', async () => {
  const localItem = item('item_1', 'local secret', '2026-11-17T00:00:00.000Z');
  const state = { item: localItem, revision: 2, baseRevision: 2 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 3, sequence: 4, item_id: 'item_1' })],
    local,
    async () => item('item_other', 'injected', '2026-11-17T04:00:00.000Z'),
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.tombstones, []);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].item_id, 'item_1');
  assert.match(result.rejected[0].reason, /id/i);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').item.id, 'item_1');
  assert.equal(local.get('item_1').item.title, 'local secret');
  assert.equal(local.get('item_1').revision, 2);
  assert.equal(local.has('item_other'), false);
});

test('two offline edits of the same item are retained as a conflict, not silently dropped', async () => {
  // Both devices last synced revision 3, then each edited offline.
  // Each optimistic revision is 4, so the remote event is not "newer",
  // but it is a different edit and must be kept beside the local one.
  const localItem = item('item_1', 'edited on laptop', '2026-11-17T02:00:00.000Z');
  const remoteItem = item('item_1', 'edited on phone', '2026-11-17T02:05:00.000Z');
  const state = { item: localItem, revision: 4, baseRevision: 3 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 4, sequence: 9, device_id: 'phone' })],
    local,
    async () => remoteItem,
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.tombstones, []);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.equal(conflict.kind, 'same_item_both_changed');
  assert.equal(conflict.resolution, 'unresolved');
  assert.equal(conflict.item_id, 'item_1');
  assert.equal(conflict.local_revision, 4);
  assert.equal(conflict.remote_revision, 4);
  assert.equal(conflict.base_revision, 3);
  assert.equal(conflict.local, localItem);
  assert.equal(conflict.remote, remoteItem);
  assert.equal(conflict.id, 'conflict_item_1_4');
  assert.equal(conflict.local.title, 'edited on laptop');
  assert.equal(conflict.remote.title, 'edited on phone');
  assert.notEqual(conflict.local.title, conflict.remote.title);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').item.title, 'edited on laptop');
  assert.equal(local.get('item_1').revision, 4);
  assert.equal(local.get('item_1').baseRevision, 3);

  // Local moved further (revision 5). The other device's revision 4 is
  // numerically older and must still be retained.
  const aheadItem = item('item_1', 'laptop edited twice', '2026-11-17T03:00:00.000Z');
  const olderRemote = item('item_1', 'phone edited once', '2026-11-17T02:30:00.000Z');
  const ahead = { item: aheadItem, revision: 5, baseRevision: 3 };
  const aheadMap = new Map([['item_1', ahead]]);
  const older = await applyRemoteEvents(
    [upsert({ id: 'evt_older', revision: 4, sequence: 8, device_id: 'phone' })],
    aheadMap,
    async () => olderRemote,
  );
  assert.deepEqual(older.applied, []);
  assert.deepEqual(older.skipped, []);
  assert.deepEqual(older.rejected, []);
  assert.equal(older.conflicts.length, 1);
  assert.equal(older.conflicts[0].local, aheadItem);
  assert.equal(older.conflicts[0].remote, olderRemote);
  assert.equal(older.conflicts[0].local.title, 'laptop edited twice');
  assert.equal(older.conflicts[0].remote.title, 'phone edited once');
  assert.equal(aheadMap.get('item_1'), ahead);
  assert.equal(aheadMap.get('item_1').revision, 5);
});

test('a newer remote edit is not applied over an offline local edit', async () => {
  const localItem = item('item_1', 'edited on laptop', '2026-11-17T02:00:00.000Z');
  const remoteItem = item('item_1', 'edited on phone', '2026-11-17T02:05:00.000Z');
  const state = { item: localItem, revision: 4, baseRevision: 3 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 5, sequence: 10, device_id: 'phone' })],
    local,
    async () => remoteItem,
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, 'same_item_both_changed');
  assert.equal(result.conflicts[0].local, localItem);
  assert.equal(result.conflicts[0].remote, remoteItem);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item.title, 'edited on laptop');
  assert.equal(local.get('item_1').revision, 4);
});

test('decrypted id mismatch on a divergent offline edit is rejected and does not overwrite the local item', async () => {
  const localItem = item('item_1', 'edited on laptop', '2026-11-17T02:00:00.000Z');
  const state = { item: localItem, revision: 4, baseRevision: 3 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 4, sequence: 9, device_id: 'phone' })],
    local,
    async () => item('item_other', 'injected', '2026-11-17T02:05:00.000Z'),
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.tombstones, []);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].item_id, 'item_1');
  assert.match(result.rejected[0].reason, /id/i);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').item.title, 'edited on laptop');
  assert.equal(local.has('item_other'), false);
});

test('same plaintext echoed at the local revision is not applied and is not a second conflict', async () => {
  const localItem = item('item_1', 'edited on laptop', '2026-11-17T02:00:00.000Z');
  const state = { item: localItem, revision: 4, baseRevision: 3 };
  const local = new Map([['item_1', state]]);
  // Different key order, same plaintext. Must not depend on a signature.
  const echoed = {
    updated_at: localItem.updated_at,
    created_at: localItem.created_at,
    attachments: [...localItem.attachments],
    relations: localItem.relations.map((relation) => ({ ...relation })),
    tags: [...localItem.tags],
    fields: { notes: localItem.fields.notes },
    title: localItem.title,
    schema_version: localItem.schema_version,
    type: localItem.type,
    id: localItem.id,
  };

  const result = await applyRemoteEvents(
    [upsert({ revision: 4, sequence: 9, device_id: 'phone' })],
    local,
    async () => echoed,
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].item_id, 'item_1');
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').item.title, 'edited on laptop');
  assert.equal(local.get('item_1').revision, 4);
});

test('remote revision older than the synced base is skipped as history, pending local edit preserved', async () => {
  const localItem = item('item_1', 'pending local edit', '2026-11-17T03:00:00.000Z');
  const remoteItem = item('item_1', 'old remote history', '2026-11-17T01:00:00.000Z');
  const state = { item: localItem, revision: 6, baseRevision: 5 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 2, sequence: 2 })],
    local,
    async () => remoteItem,
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.tombstones, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].item_id, 'item_1');
  assert.equal(result.skipped[0].reason, 'stale revision: not newer than local');
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').item.title, 'pending local edit');
  assert.equal(local.get('item_1').revision, 6);
  assert.equal(local.get('item_1').baseRevision, 5);
});

test('remote revision equal to baseRevision with a pending local edit is skipped, not a conflict', async () => {
  // Existing semantics: remote === base means the remote side is untouched
  // since the synced base (detectConflict 'none'), and it is not newer than
  // local, so it is a stale echo. The pending local edit is kept.
  const localItem = item('item_1', 'pending local edit', '2026-11-17T03:00:00.000Z');
  const remoteItem = item('item_1', 'synced base version', '2026-11-17T01:00:00.000Z');
  const state = { item: localItem, revision: 6, baseRevision: 5 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 5, sequence: 5 })],
    local,
    async () => remoteItem,
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'stale revision: not newer than local');
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').revision, 6);
  assert.equal(local.get('item_1').baseRevision, 5);
});

test('base 3 / local 5 / remote 4 is still a conflict and both versions are retained', async () => {
  const localItem = item('item_1', 'laptop edits', '2026-11-17T03:00:00.000Z');
  const remoteItem = item('item_1', 'phone edit', '2026-11-17T02:00:00.000Z');
  const state = { item: localItem, revision: 5, baseRevision: 3 };
  const local = new Map([['item_1', state]]);

  const result = await applyRemoteEvents(
    [upsert({ revision: 4, sequence: 4, device_id: 'phone' })],
    local,
    async () => remoteItem,
  );

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.equal(conflict.kind, 'same_item_both_changed');
  assert.equal(conflict.resolution, 'unresolved');
  assert.equal(conflict.local_revision, 5);
  assert.equal(conflict.remote_revision, 4);
  assert.equal(conflict.base_revision, 3);
  assert.equal(conflict.local, localItem);
  assert.equal(conflict.remote, remoteItem);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item, localItem);
  assert.equal(local.get('item_1').revision, 5);
  assert.equal(local.get('item_1').baseRevision, 3);
});
