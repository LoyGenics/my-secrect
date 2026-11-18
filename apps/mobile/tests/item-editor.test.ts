import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ItemType, VaultItem } from '../../../packages/core/src/types';
import {
  CUSTOM_FIELD_META, customFieldKey, daysInMonth, editorDraftSignature, formatEditorDate, getEditorIssues,
  incompatibleFieldLabels, normalizeCardExpiry, normalizeWebsite, parseEditorDate, readCustomFields, readTemplateFields,
  reclassifyDraft, serializeEditorFields,
} from '../src/utils/itemEditor';

const created = '2026-11-01T12:00:00.000Z';
const updated = '2026-11-18T12:00:00.000Z';
function item(type: ItemType, fields: Record<string, unknown>): VaultItem {
  return { id: 'synthetic-item', type, schema_version: 1, title: 'Synthetic', fields, tags: [],
    relations: [], attachments: [], created_at: created, updated_at: created };
}

function switchType(initial: VaultItem, type: ItemType) {
  const fields = readTemplateFields(initial);
  const extras = readCustomFields(initial);
  const draft = reclassifyDraft(type, initial.type, fields, extras);
  const result = serializeEditorFields(type, draft.fields, draft.custom, initial, updated);
  return { fields: result, losses: incompatibleFieldLabels(type, initial.type, fields, extras, initial) };
}

test('Login to Note removes password, TOTP, URL and history but retains approved custom data and archive state', () => {
  const result = switchType(item('login', {
    username: 'account', password: 'secret', totp_secret: 'BASE32PLACEHOLDER', url: 'https://example.test', notes: 'keep',
    favorite_color: 'orange', archived: true, password_history: [{ password: 'old', changed_at: created }],
  }), 'secure_note');
  assert.deepEqual(result.fields, { notes: 'keep', favorite_color: 'orange', archived: true });
  assert.deepEqual(result.losses, ['username', 'password', 'totp_secret', 'url', 'password_history']);
});

test('Bank to Identity removes account fields while retaining transferable notes', () => {
  assert.deepEqual(switchType(item('bank_account', {
    bank_name: 'Example', account_number: 'secret', holder_name: 'Ada', currency: 'VND', branch: 'West', notes: 'carry',
  }), 'identity'), {
    fields: { notes: 'carry' },
    losses: ['bank_name', 'account_number', 'holder_name', 'currency', 'branch'],
  });
});

test('API key to Login removes the key, scopes and expiry and keeps the service metadata', () => {
  assert.deepEqual(switchType(item('api_key', {
    service: 'Example', key: 'synthetic', scopes: 'read', expires_at: '2028-06-01',
  }), 'login'), {
    fields: { service: 'Example' },
    losses: ['key', 'scopes', 'expires_at'],
  });
});

test('old incompatible data needs confirmation and forbidden CVV-like entries never join an item payload', () => {
  const initial = item('secure_note', { body: 'text', password: 'legacy leaked field', OTP: '123456', structured: { flag: true } });
  assert.deepEqual(incompatibleFieldLabels('secure_note', initial.type, readTemplateFields(initial), readCustomFields(initial), initial), ['password']);
  const updated = serializeEditorFields('secure_note', readTemplateFields(initial), readCustomFields(initial), initial, created);
  assert.deepEqual(updated, { body: 'text', structured: { flag: true } });
});

test('password history and note revisions stay with the relevant type and preserve significant whitespace', () => {
  const login = item('login', { username: 'user', password: '  exact  ' });
  const password = serializeEditorFields('login', { ...readTemplateFields(login), password: '  replacement   ' }, [], login, updated);
  assert.equal(password.password, '  replacement   ');
  assert.deepEqual(password.password_history, [{ password: '  exact  ', changed_at: updated }]);
  const note = item('secure_note', { body: '  old body  ' });
  const edited = serializeEditorFields('secure_note', { body: '  new note   ' }, [], note, updated);
  assert.equal(edited.body, '  new note   ');
  assert.deepEqual(edited.revisions, [{ body: '  old body  ', saved_at: updated }]);
  const changed = switchType(note, 'login');
  assert.equal(changed.fields.revisions, undefined);
  assert.equal(serializeEditorFields('login', { username: 'draft', password: '  ' }, [], login, updated).password, '  ');
});

test('v1 custom fields round-trip in order and the metadata carries names and types without secret values', () => {
  const key = customFieldKey('samplesecret', 'secret');
  const fields = serializeEditorFields('custom', {}, [
    { key: customFieldKey('sampledate', 'date'), label: 'Review', kind: 'date', value: '2028-02-29', typed: true },
    { key, label: 'Door code', kind: 'secret', value: ' 007 ', typed: true },
    { key: 'legacyLabel', label: 'legacyLabel', kind: 'text', value: 17, typed: false },
  ], undefined, updated);
  const stored = JSON.parse(JSON.stringify(item('custom', fields))) as VaultItem;
  assert.match(String(stored.fields[CUSTOM_FIELD_META]), /"version":1/);
  assert.doesNotMatch(String(stored.fields[CUSTOM_FIELD_META]), /007/);
  assert.deepEqual(readCustomFields(stored).map(({ label, kind, value }) => [label, kind, value]), [
    ['Review', 'date', '2028-02-29'], ['Door code', 'secret', ' 007 '], ['legacyLabel', 'text', 17],
  ]);
  assert.equal(stored.fields[key], ' 007 ');
  assert.equal(readTemplateFields(stored)[key], undefined);
  const reordered = serializeEditorFields('custom', {}, readCustomFields(stored).reverse(), stored, updated);
  assert.deepEqual(readCustomFields(item('custom', reordered)).map(({ label }) => label), ['legacyLabel', 'Door code', 'Review']);
});

test('template conversion cannot treat a legacy custom key as a built-in credential', () => {
  const initial = item('custom', { password: 'legacy custom', nickname: 'Ada' });
  const result = switchType(initial, 'login');
  assert.deepEqual(result.fields, { nickname: 'Ada' });
  assert.deepEqual(result.losses, ['password']);
});

test('full number, detected network, normalized expiry and credit terms survive without including the local CVV', () => {
  const input = { cardholder: 'Ada', card_number: '4242-4242-4242-4242', card_type: 'credit',
    expiry: '2030-12', statement_day: '15', credit_limit: '1,000 USD' };
  assert.deepEqual(getEditorIssues('card', input, '047'), {});
  const fields = serializeEditorFields('card', { ...input, CVC: '047', cvv: '047' }, [], undefined, updated);
  assert.deepEqual(fields, { ...input, card_number: '4242424242424242', brand: 'Visa', last4: '4242', expiry: '12/30' });
  const old = item('card', { cardholder: 'Ada', last4: '4242', bank: 'Example Bank', expiry: '12/30' });
  assert.equal(serializeEditorFields('card', readTemplateFields(old), [], old, updated).last4, '4242');
  assert.deepEqual(incompatibleFieldLabels('secure_note', 'card', readTemplateFields(old), [], old, true), ['cardholder', 'last4', 'bank', 'expiry', 'cvv']);
});

test('validation handles invalid website, TOTP, expiry, CVV and statement day independently', () => {
  assert.deepEqual(getEditorIssues('login', { url: 'https://exa mple.test', username: '', totp_secret: '123456' }), {
    username: 'required', url: 'url', totp_secret: 'totp',
  });
  assert.deepEqual(getEditorIssues('card', { expiry: '13/27', card_type: 'credit', statement_day: '32', card_number: '123' }, '9'), {
    card_number: 'cardNumber', cvv: 'cvv', statement_day: 'statementDay', expiry: 'expiry',
  });
  assert.deepEqual(normalizeWebsite('example.test/login?ref=123'), { url: 'https://example.test/login?ref=123', host: 'example.test' });
  assert.deepEqual(normalizeWebsite('HTTPS://Ví-dụ.test/path#exact'), { url: 'HTTPS://Ví-dụ.test/path#exact', host: 'Ví-dụ.test' });
  assert.equal(normalizeWebsite('ftp://example.test'), undefined);
  assert.equal(normalizeWebsite('https://user:pass@example.test'), undefined);
  assert.equal(normalizeWebsite('http://localhost:99999'), undefined);
  assert.equal(normalizeCardExpiry(' 09 / 2033 '), '09/33');
});

test('calendar validates Gregorian leap-day dates with a stable ISO document format', () => {
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(parseEditorDate('2027-02-29'), undefined);
  assert.equal(parseEditorDate('2028-04-31'), undefined);
  assert.deepEqual(parseEditorDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
  assert.equal(formatEditorDate(2028, 2, 9), '2028-02-09');
});

test('dirty signature ignores property order and detects favorites, typed field reordering and local CVV changes', () => {
  const draft = { type: 'card' as const, title: 'Card', fields: { brand: 'Visa', last4: '4242' },
    tags: [] as string[], relationIds: [] as string[], favorite: false, cardCodeEdited: false,
    customFields: [
      { key: 'custom_a', label: 'A', kind: 'text', value: 'A', typed: true },
      { key: 'custom_b', label: 'B', kind: 'secret', value: 'B', typed: true },
    ] as const };
  const original = editorDraftSignature(draft);
  assert.equal(editorDraftSignature({ ...draft, fields: { last4: '4242', brand: 'Visa' } }), original);
  assert.notEqual(editorDraftSignature({ ...draft, favorite: true }), original);
  assert.notEqual(editorDraftSignature({ ...draft, cardCodeEdited: true }), original);
  assert.notEqual(editorDraftSignature({ ...draft, customFields: [...draft.customFields].reverse() }), original);
});
