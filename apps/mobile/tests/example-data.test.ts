/**
 * Example data gets fresh ids per load (the server keeps item ids unique
 * across vaults, so fixed ids collided between two accounts), keeps its
 * relations inside the set, and is found again by its tag.
 * Run: npx tsx --test apps/mobile/tests/example-data.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sodiumReady } from '../../../packages/crypto-adapters/src/index';
import { exampleItems, isExampleItem } from '../src/utils/exampleData';

test('each load gets fresh random item ids', async () => {
  await sodiumReady;
  const first = exampleItems();
  const second = exampleItems();
  assert.equal(first.length, 11);
  for (const item of [...first, ...second]) assert.match(item.id, /^item_[0-9a-f]{32}$/);
  assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 22);
});

test('relations point at items of the same load', async () => {
  await sodiumReady;
  const items = exampleItems();
  const id = (type: string) => items.find((item) => item.type === type)?.id;
  const byType = (type: string) => items.find((item) => item.type === type)?.relations;
  assert.deepEqual(byType('login'), [{ type: 'has_bank', target_id: id('bank_account') }]);
  assert.deepEqual(byType('bank_account'), [{ type: 'has_login', target_id: id('login') }, { type: 'has_card', target_id: id('card') }]);
  assert.deepEqual(byType('card'), [{ type: 'belongs_to', target_id: id('bank_account') }]);
  assert.deepEqual(byType('collection'), [
    { type: 'contains', target_id: id('login') },
    { type: 'contains', target_id: id('ssh_key') },
    { type: 'contains', target_id: id('api_key') },
  ]);
});

test('example items are recognised by tag, not by id', async () => {
  await sodiumReady;
  const items = exampleItems();
  assert.ok(items.every(isExampleItem));
  assert.equal(isExampleItem({ ...items[0], tags: ['email'] }), false);
});
