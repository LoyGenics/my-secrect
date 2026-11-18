import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCsvDuplicates, LOGIN_CSV_TEMPLATE, parseCsvImport } from '../../packages/import-export/src/index';
import { csvDraftToLoginItem, importTotpSecret, normalizeAiPreview } from '../../packages/import-export/src/itemImport';
import { isValidBase32Secret } from './src/utils/totp';

test('normalizes the My Secret template and Google CSV without changing credential bytes', () => {
  const template = parseCsvImport(LOGIN_CSV_TEMPLATE + 'Mail,https://example.test," user "," a, ""b"" ",,,"Work",1\r\n');
  assert.equal(template.source, 'my-secret');
  assert.deepEqual(template.errors, []);
  const item = csvDraftToLoginItem(template.drafts[0], isValidBase32Secret);
  assert.equal(item.fields.password, ' a, "b" ');
  assert.equal(item.fields.username, ' user ');
  assert.deepEqual(item.tags, ['imported', 'Work']);
  assert.equal(item.favorite, true);

  const google = parseCsvImport('\uFEFFname,url,username,password,note\r\nMail,https://example.test,user,abc,"line 1\nline 2"');
  assert.equal(google.source, 'google');
  assert.equal(google.drafts[0].notes, 'line 1\nline 2');
});

test('preserves 1Password metadata, skips unsupported Bitwarden rows, and rejects malformed quoting', () => {
  const onePassword = parseCsvImport('Title,Website,Username,Password,Favourite,Archived,Tags\nMail,,user,abc,1,true,"Personal, Mail"');
  assert.equal(onePassword.source, '1password');
  assert.equal(csvDraftToLoginItem(onePassword.drafts[0], isValidBase32Secret).fields.archived, true);
  assert.equal(onePassword.drafts[0].favorite, true);
  assert.deepEqual(onePassword.drafts[0].tags, ['Personal', 'Mail']);

  const bitwarden = parseCsvImport('folder,type,name,login_username,login_password\nWork,note,Note,,\nWork,login,Login,alice,abc');
  assert.equal(bitwarden.drafts.length, 1);
  assert.equal(bitwarden.skipped[0].row, 2);
  assert.deepEqual(parseCsvImport(LOGIN_CSV_TEMPLATE + 'Mail,"unterminated').errors, ['empty_or_malformed']);
});

test('flags repeated logins and imports compatible TOTP setup URIs only', () => {
  const result = parseCsvImport('name,url,username,password\nFirst,https://example.test/a,Ada,a\nSecond,https://example.test/b,ada,b');
  assert.equal(detectCsvDuplicates(result.drafts, [])[0].fromBatch, true);
  const existing = csvDraftToLoginItem(result.drafts[0], isValidBase32Secret);
  assert.equal(detectCsvDuplicates(result.drafts, [existing])[0].existingId, existing.id);
  const secret = 'JBSWY3DPEHPK3PXP';
  assert.equal(importTotpSecret(`otpauth://totp/Example?secret=${secret}&period=30`, isValidBase32Secret), secret);
  assert.equal(importTotpSecret(`otpauth://totp/Example?secret=${secret}&digits=8`, isValidBase32Secret), undefined);
  assert.equal(importTotpSecret('123456', isValidBase32Secret), undefined);
});

test('AI preview permits known fields and rejects invented credentials and unsupported types', () => {
  const source = 'Login: Ada\nPassword: exact-synthetic-value\nRemember the meeting.';
  const { items, skipped } = normalizeAiPreview({ items: [
    { type: 'login', title: 'Mail', fields: { username: 'Ada', password: 'exact-synthetic-value', url: null } },
    { type: 'login', title: 'Invented', fields: { password: 'invented' } },
    { type: 'secure_note', title: 'Reminder', fields: { body: 'Remember the meeting.' } },
    { type: 'secure_note', title: 'Forbidden', fields: { body: 'Text', pin: '1234' } },
    { type: 'document', title: 'Missing attachment', fields: { blob_id: 'fake' } },
  ] }, source, isValidBase32Secret);
  assert.deepEqual(skipped, [2, 4, 5]);
  assert.deepEqual(items.map(({ type, fields }) => ({ type, fields })), [
    { type: 'login', fields: { username: 'Ada', password: 'exact-synthetic-value' } },
    { type: 'secure_note', fields: { body: 'Remember the meeting.' } },
  ]);
});
