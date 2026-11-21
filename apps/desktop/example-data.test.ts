/**
 * Example data gets fresh ids per load (the server keeps item ids unique
 * across vaults, so fixed ids collided between two accounts), keeps its
 * relations inside the set, and is found again by its tag.
 *
 * Run: npx tsx --test apps/desktop/example-data.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExampleItems, isExampleItem } from './src/utils/exampleData';

test('each load gets fresh random item ids', () => {
  const first = buildExampleItems();
  const second = buildExampleItems();
  assert.equal(first.length, 12);
  for (const item of [...first, ...second]) assert.match(item.id, /^item_[0-9a-f]{24}$/);
  const ids = new Set([...first, ...second].map((item) => item.id));
  assert.equal(ids.size, 24);
});

test('relations point at items of the same load', () => {
  const items = buildExampleItems();
  const byTitle = new Map(items.map((item) => [item.title, item.id]));
  const bank = items.find((item) => item.type === 'bank_account');
  assert.deepEqual(bank?.relations, [
    { type: 'has_login', target_id: byTitle.get('Example Website') },
    { type: 'has_card', target_id: byTitle.get('Example Visa') },
  ]);
  const collection = items.find((item) => item.type === 'collection');
  assert.deepEqual(collection?.relations, [{ type: 'related_to', target_id: byTitle.get('Example Website') }]);
});

test('example items are recognised by tag, not by id', () => {
  const items = buildExampleItems();
  assert.ok(items.every(isExampleItem));
  assert.equal(isExampleItem({ ...items[0], tags: ['work'] }), false);
});
