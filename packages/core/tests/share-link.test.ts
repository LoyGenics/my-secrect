import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareLink, openShareLink, shareLinkSnapshot, shareLinkURL } from '../src/share-link';
import type { VaultItem } from '../src/types';
const now = Date.parse('2026-11-18T00:00:00.000Z');
const item: VaultItem = { id: 'private-id', type: 'login', schema_version: 1, title: 'Example Mail', fields: { username: 'review@example.com', password: 'example-secret', url: 'https://example.com', password_history: ['old-secret'], revisions: ['private-note'], archived: true }, tags: ['private-tag'], relations: [{ type: 'related_to', target_id: 'private-bank' }], attachments: ['private-blob'], favorite: true, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() };
test('independent read-only snapshots exclude private metadata and do not change with later edits', async () => {
  const { record, secret } = await createShareLink(item, 86400, now);
  assert.equal(record.encrypted_payload.includes('example-secret'), false);
  const opened = await openShareLink(record, secret, now);
  assert.deepEqual(opened.fields, { username: 'review@example.com', password: 'example-secret', url: 'https://example.com' });
  assert.deepEqual(opened.tags, []); assert.deepEqual(opened.attachments, []); assert.deepEqual(opened.relations, []); assert.equal(opened.id, 'shared-copy');
  assert.equal(item.fields.password_history?.[0], 'old-secret');
  assert.equal(new URL(shareLinkURL('https://vault.example.com', record.id, secret)).hash, `#k=${secret}`);
  assert.equal(Object.keys(record).includes('secret'), false);
});
test('tampering, moved records, wrong key, unsupported format, and changed expiry all fail closed', async () => {
  const a = await createShareLink(item, 3600, now); const b = await createShareLink(item, 3600, now);
  await assert.rejects(() => openShareLink(a.record, b.secret, now));
  await assert.rejects(() => openShareLink({ ...a.record, id: b.record.id }, a.secret, now));
  await assert.rejects(() => openShareLink({ ...a.record, expires_at: new Date(now + 7200000).toISOString() }, a.secret, now));
  await assert.rejects(() => openShareLink({ ...a.record, format_version: 2 }, a.secret, now));
  await assert.rejects(() => openShareLink({ ...a.record, encrypted_payload: a.record.encrypted_payload.slice(0, -8) + 'AAAAAAAA' }, a.secret, now));
  await assert.rejects(() => openShareLink(a.record, a.secret, now + 3600000), /expired/);
  assert.notEqual(a.secret, b.secret); assert.notEqual(a.record.id, b.record.id); assert.notEqual(a.record.encrypted_payload, b.record.encrypted_payload);
});
test('invalid TTL, file sharing, forbidden fields and unsafe key destinations are rejected', async () => {
  await assert.rejects(() => createShareLink(item, 0, now));
  assert.throws(() => shareLinkSnapshot({ ...item, type: 'document' }));
  await assert.rejects(() => createShareLink({ ...item, fields: { ...item.fields, cvv: '123' } }, 3600, now));
  const link = await createShareLink(item, 3600, now);
  for (const origin of ['javascript:alert(1)','http://vault.example.com','https://user:pass@vault.example.com']) assert.throws(() => shareLinkURL(origin, link.record.id, link.secret));
});

test('opens the independent PyNaCl vector with Unicode intact', async () => {
  const { readFile } = await import('node:fs/promises');
  const vector = JSON.parse(await readFile(new URL('../../../tests/crypto-vectors/share-link-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(await openShareLink(vector.record, vector.secret, vector.now), vector.expected);
});
