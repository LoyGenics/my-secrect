import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDetailFieldsForClipboard, getPrimaryDetailAction } from '../src/utils/detailAction';

test('copy all formats bank details with their labels and preserves leading zeros', () => {
  assert.equal(formatDetailFieldsForClipboard([
    { label: 'Tên ngân hàng', value: 'Ngân hàng mẫu' },
    { label: 'Tên chủ tài khoản', value: 'Nguyễn Văn A' },
    { label: 'Số tài khoản', value: '00123456789' },
    { label: 'Chi nhánh', value: '' },
  ]), 'Tên ngân hàng: Ngân hàng mẫu\nTên chủ tài khoản: Nguyễn Văn A\nSố tài khoản: 00123456789');
});

test('copy all keeps exact values and skips fields copied individually, such as CVV', () => {
  assert.equal(formatDetailFieldsForClipboard([
    { label: 'Password', value: ' sample password ' },
    { label: 'CVV', value: '000', includeInCopyAll: false },
    { label: 'Notes', value: 'First line\nSecond line' },
  ]), 'Password:  sample password \nNotes:\nFirst line\nSecond line');
  assert.equal(formatDetailFieldsForClipboard([{ label: 'CVV', value: '000', includeInCopyAll: false }]), '');
});

test('login copies the password with username fallback, preserving the original value', () => {
  assert.deepEqual(getPrimaryDetailAction({ type: 'login', fields: { password: ' synthetic password ', username: 'test-user' } }),
    { type: 'copy', key: 'password', value: ' synthetic password ' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'login', fields: { username: 'test-user' } }),
    { type: 'copy', key: 'username', value: 'test-user' });
});

test('card primary actions copy only the final four digits from full and legacy records', () => {
  assert.deepEqual(getPrimaryDetailAction({ type: 'card', fields: { card_number: '0000 0000 0000 0017', last4: '0000' } }),
    { type: 'copy', key: 'last4', value: '0017' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'card', fields: { last4: '0017' } }),
    { type: 'copy', key: 'last4', value: '0017' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'card', fields: { cvv: '000', last4: '???' } }), { type: 'edit' });
});

test('the primary button follows the active item type, even with stale hidden values', () => {
  assert.deepEqual(getPrimaryDetailAction({ type: 'secure_note', fields: { password: 'legacy', body: 'note' } }), { type: 'copy', key: 'body', value: 'note' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'bank_account', fields: { password: 'legacy', account_number: 'TEST-ACCOUNT' } }),
    { type: 'copy', key: 'account_number', value: 'TEST-ACCOUNT' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'identity', fields: { document_number: 'TEST-IDENTITY' } }),
    { type: 'copy', key: 'document_number', value: 'TEST-IDENTITY' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'api_key', fields: { key: 'synthetic-api-key' } }),
    { type: 'copy', key: 'key', value: 'synthetic-api-key' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'custom', fields: { password: 'legacy' } }), { type: 'edit' });
});

test('route actions require a route, and trash takes precedence over copying and navigation', () => {
  const collection = { type: 'collection', fields: {} } as const;
  assert.deepEqual(getPrimaryDetailAction(collection, { canOpenCollection: true }), { type: 'openCollection' });
  assert.deepEqual(getPrimaryDetailAction(collection), { type: 'edit' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'media', fields: {} }, { canOpenFile: true }), { type: 'openFile' });
  assert.deepEqual(getPrimaryDetailAction(collection, { canOpenCollection: true, inTrash: true }), { type: 'restore' });
  assert.deepEqual(getPrimaryDetailAction({ type: 'login', fields: { password: 'example' } }, { inTrash: true }), { type: 'restore' });
});
