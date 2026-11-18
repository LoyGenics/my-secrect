import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ItemType, VaultItem } from '../../../packages/core/src/types';
import { activeFilterCount, clearVaultFilters, createVaultFilter, filterVaultItems, toggleFilterValue } from '../src/utils/vaultFilter';
import { indexVaultSearch, normalizeVaultQuery, searchVaultIndex } from '../src/utils/vaultSearch';

const created = '2026-01-01T00:00:00Z';
const updated = '2026-02-01T00:00:00Z';

function item(id: string, patch: Partial<VaultItem> = {}): VaultItem {
  return { id, type: 'login', schema_version: 1, title: id, fields: {}, tags: [], relations: [], attachments: [], created_at: created, updated_at: updated, ...patch };
}

test('filters use OR inside groups and AND across groups, including favorites', () => {
  const entries = [
    item('bank', { type: 'bank_account', tags: ['work'], favorite: true }),
    item('card', { type: 'card', tags: ['tax'], favorite: true }),
    item('wrong-type', { tags: ['work'], favorite: true }),
    item('wrong-tag', { type: 'card', tags: ['personal'], favorite: true }),
    item('not-favorite', { type: 'card', tags: ['work'] }),
    item('trash', { type: 'card', tags: ['work'], favorite: true, deleted_at: updated }),
  ];
  const values = new Set<ItemType>(['bank_account']);
  const types = toggleFilterValue(values, 'card');
  assert.deepEqual([...values], ['bank_account']);
  assert.deepEqual([...toggleFilterValue(types, 'card')], ['bank_account']);
  const filter = { ...createVaultFilter(), scope: 'favorites' as const, types, tags: new Set(['work', 'tax']), sort: 'titleAsc' as const };
  assert.equal(activeFilterCount(filter), 5);
  assert.deepEqual(filterVaultItems(entries, filter).map((row) => row.id), ['bank', 'card']);
  assert.equal(activeFilterCount(clearVaultFilters(filter)), 0);
  assert.equal(clearVaultFilters(filter).sort, 'titleAsc');
});

test('collections find linked contents and nested descendants safely', () => {
  const entries = [
    item('collection-root', { type: 'collection', relations: [{ type: 'contains', target_id: 'explicit' }] }),
    item('collection-nested', { type: 'collection', fields: { parent_id: 'collection-root' } }),
    item('collection-leaf', { type: 'collection', fields: { parent_id: 'collection-nested' } }),
    item('nested-link', { fields: { parent_id: 'collection-leaf' } }),
    item('membership', { relations: [{ type: 'belongs_to', target_id: 'collection-nested' }] }),
    item('explicit'),
    item('cycle-a', { type: 'collection', fields: { parent_id: 'cycle-b' } }),
    item('cycle-b', { type: 'collection', fields: { parent_id: 'cycle-a' } }),
  ];
  const filter = { ...createVaultFilter(), collectionIds: new Set(['collection-root']) };
  assert.deepEqual(filterVaultItems(entries, filter).map((row) => row.id), ['collection-leaf', 'collection-nested', 'explicit', 'membership', 'nested-link']);
});

test('sort keys are independent from filters and order duplicates deterministically', () => {
  const entries = [
    item('b', { title: 'Account 10', created_at: '2026-01-15T00:00:00Z' }),
    item('a1', { title: 'Account 2' }),
    item('a0', { title: 'Account 2', updated_at: '2026-04-01T00:00:00Z' }),
  ];
  const base = createVaultFilter();
  assert.deepEqual(filterVaultItems(entries, base).map((row) => row.id), ['a0', 'a1', 'b']);
  assert.deepEqual(filterVaultItems(entries, { ...base, sort: 'titleAsc' }).map((row) => row.id), ['a0', 'a1', 'b']);
  assert.deepEqual(filterVaultItems(entries, { ...base, sort: 'createdDesc' }).map((row) => row.id), ['b', 'a0', 'a1']);
});

test('ranks exact title, hostname, username, tags and approved metadata in Vietnamese', () => {
  const entries = [
    item('metadata', { type: 'bank_account', title: 'Bank', fields: { holder_name: 'Đông' } }),
    item('tag', { title: 'Tagged', tags: ['Đông'] }),
    item('user', { title: 'Account', fields: { username: 'Đông' } }),
    item('host', { title: 'Website', fields: { url: 'https://dong.example.test' } }),
    item('substring', { title: 'Phía Đông' }),
    item('exact', { title: 'Đông' }),
  ];
  const index = indexVaultSearch(entries);
  assert.equal(normalizeVaultQuery('  ĐẶNG Phương  '), 'dang phuong');
  assert.deepEqual(searchVaultIndex(index, entries, 'dong', undefined, 'vi').map((row) => row.id), ['exact', 'substring', 'host', 'user', 'tag', 'metadata']);
  assert.deepEqual(searchVaultIndex(index, entries, 'https://dong.example.test/a').map((row) => row.id), ['host']);
});

test('search honors context, excludes archives by default and indexes file names only', () => {
  const entries = [
    item('login', { title: 'Tax account', tags: ['work'], favorite: true, fields: { url: 'https://user:password-bearing@example.test/tokenish?pw=abcSecret#privateFragment', password: 'known-secret-password', notes: 'Index this private sentence?', totp_secret: 'known-totp' } }),
    item('archive', { title: 'Tax note', fields: { archived: true } }),
    item('note', { title: 'Household', type: 'secure_note', fields: { body: 'known-secret-note' } }),
    item('file', { title: 'Tax file', type: 'document', fields: { file_name: 'deduction.pdf', blob_id: 'opaque-blob', body: 'known-secret-file' } }),
    item('card', { title: 'Tax payment', type: 'card', fields: { card_number: '4242424242424242', cvv: '1010', cardholder: 'Example Person' } }),
  ];
  const index = indexVaultSearch(entries);
  const filter = { ...createVaultFilter(), scope: 'favorites' as const, tags: new Set(['work']) };
  assert.deepEqual(searchVaultIndex(index, entries, 'tax', filter).map((row) => row.id), ['login']);
  assert.equal(searchVaultIndex(index, entries, 'tax').some((row) => row.id === 'archive'), false);
  assert.deepEqual(searchVaultIndex(indexVaultSearch(entries, true), entries, 'tax').map((row) => row.id), ['archive']);
  assert.deepEqual(searchVaultIndex(index, entries, 'deduction.pdf').map((row) => row.id), ['file']);
  for (const sensitive of ['known-secret', 'known-totp', 'opaque-blob', 'private sentence', '4242424242424242', '1010', 'password-bearing', 'tokenish', 'abcSecret', 'privateFragment']) {
    assert.deepEqual(searchVaultIndex(index, entries, sensitive), []);
  }
});

for (const count of [0, 1, 50, 1000, 5000]) {
  test(`handles ${count} items and distinct tags without dropping matches`, () => {
    const entries = Array.from({ length: count }, (_, id) => item(String(id), { title: `Example item ${id}`, tags: [`tag-${id}`] }));
    const index = indexVaultSearch(entries);
    assert.equal(searchVaultIndex(index, entries, '').length, Math.min(8, count));
    assert.equal(searchVaultIndex(index, entries, 'example item').length, count);
    assert.equal(filterVaultItems(entries, { ...createVaultFilter(), tags: new Set(['tag-0']) }).length, Math.min(1, count));
  });
}
