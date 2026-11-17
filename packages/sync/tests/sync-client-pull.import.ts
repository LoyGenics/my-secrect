// Imports the real SyncClient class (parameter properties need a TS transform).
// Not named *.test.ts so plain `node --test packages/sync/tests/` stays on strip-types.
// Run: npx --yes tsx --test packages/sync/tests/sync-client-pull.import.ts
// The signature field is opaque. This file does not treat it as authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/sync-client.ts';
import { loadConflicts, memorySyncStorage } from '../src/index.ts';

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
    device_id: 'phone',
    signature: 'opaque-not-authenticated',
    created_at: '2026-11-17T01:00:00.000Z',
    encrypted_payload: 'ciphertext',
    encrypted_item_key: 'wrapped-key',
    encryption_version: 1,
    ...overrides,
  };
}

function harness(local, events, decrypt) {
  const saved = [];
  const deleted = [];
  const storage = memorySyncStorage();
  const api = {
    async syncPush() {
      throw new Error('push should not run');
    },
    async syncPull() {
      return {
        events,
        next_cursor: events.length ? String(events[events.length - 1].sequence) : null,
      };
    },
  };
  const client = new SyncClient(api, {
    vaultId: 'vault_1',
    deviceId: 'laptop',
    storage,
    decrypt,
    getLocalState: () => local,
    saveLocalItem: (savedItem, revision) => { saved.push({ savedItem, revision }); },
    deleteLocalItem: (itemId) => { deleted.push(itemId); },
  });
  return { client, saved, deleted, storage };
}

test('SyncClient.pull applies a remote upsert with a newer revision', async () => {
  const localItem = item('item_1', 'local note', '2026-11-17T00:00:00.000Z');
  const remoteItem = item('item_1', 'remote note', '2026-11-17T02:00:00.000Z');
  const local = new Map([['item_1', { item: localItem, revision: 2, baseRevision: 2 }]]);
  const { client, saved, deleted } = harness(
    local,
    [upsert({ revision: 3, sequence: 8 })],
    async () => remoteItem,
  );

  const { result } = await client.pull();

  assert.deepEqual(result.applied, ['item_1']);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(saved, [{ savedItem: remoteItem, revision: 3 }]);
  assert.deepEqual(deleted, []);
  assert.equal(local.get('item_1').item.title, 'remote note');
  assert.equal(local.get('item_1').revision, 3);
});

test('SyncClient.pull does not apply a stale revision', async () => {
  const localItem = item('item_1', 'current note', '2026-11-17T03:00:00.000Z');
  const state = { item: localItem, revision: 5, baseRevision: 5 };
  const local = new Map([['item_1', state]]);
  const { client, saved, deleted } = harness(
    local,
    [upsert({ revision: 4, sequence: 3 })],
    async () => item('item_1', 'stale remote', '2026-11-17T01:00:00.000Z'),
  );

  const { result } = await client.pull();

  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(saved, []);
  assert.deepEqual(deleted, []);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item.title, 'current note');
  assert.equal(local.get('item_1').revision, 5);
});

test('SyncClient.pull rejects a decrypted id mismatch and does not overwrite the local item', async () => {
  const localItem = item('item_1', 'local secret', '2026-11-17T00:00:00.000Z');
  const state = { item: localItem, revision: 2, baseRevision: 2 };
  const local = new Map([['item_1', state]]);
  const { client, saved, deleted } = harness(
    local,
    [upsert({ revision: 3, sequence: 4 })],
    async () => item('item_other', 'injected', '2026-11-17T04:00:00.000Z'),
  );

  const { result } = await client.pull();

  assert.deepEqual(result.applied, []);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /id/i);
  assert.deepEqual(saved, []);
  assert.deepEqual(deleted, []);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item.title, 'local secret');
  assert.equal(local.has('item_other'), false);
});

test('SyncClient.pull retains two offline edits as a conflict', async () => {
  const localItem = item('item_1', 'edited on laptop', '2026-11-17T02:00:00.000Z');
  const remoteItem = item('item_1', 'edited on phone', '2026-11-17T02:05:00.000Z');
  const state = { item: localItem, revision: 4, baseRevision: 3 };
  const local = new Map([['item_1', state]]);
  const { client, saved, deleted, storage } = harness(
    local,
    [upsert({ revision: 4, sequence: 9, device_id: 'phone' })],
    async () => remoteItem,
  );

  const { result } = await client.pull();
  const stored = loadConflicts(storage);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].local.title, 'edited on laptop');
  assert.equal(result.conflicts[0].remote.title, 'edited on phone');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].local.title, 'edited on laptop');
  assert.equal(stored[0].remote.title, 'edited on phone');
  assert.equal(stored[0].resolution, 'unresolved');
  assert.deepEqual(saved, []);
  assert.deepEqual(deleted, []);
  assert.equal(local.get('item_1'), state);
  assert.equal(local.get('item_1').item.title, 'edited on laptop');
  assert.equal(local.get('item_1').revision, 4);
});
