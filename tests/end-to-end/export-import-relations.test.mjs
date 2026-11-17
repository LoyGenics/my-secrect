// Export/import round-trip WITH relations — self-contained, plain Node 20+.
// Uses Node's AES-256-GCM as a stand-in envelope here (the real app uses
// libsodium XChaCha20-Poly1305 — see packages/crypto-adapters). What this
// test guards is the FORMAT + RELATIONS contract, not the cipher:
// relations live INSIDE the encrypted payload, survive export/import,
// and a tampered payload is rejected instead of imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function encrypt(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { nonce: nonce.toString('base64'), ciphertext: Buffer.concat([ct, cipher.getAuthTag()]).toString('base64') };
}
function decrypt(key, nonceB64, ctB64) {
  const nonce = Buffer.from(nonceB64, 'base64');
  const buf = Buffer.from(ctB64, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const bank = {
  id: 'item_01', type: 'bank_account', schema_version: 1, title: 'My Main Bank',
  fields: { bank_name: 'Example Bank', account_number: '0123456789', currency: 'VND' },
  tags: ['personal', 'finance'],
  relations: [{ type: 'has_login', target_id: 'item_02' }, { type: 'has_card', target_id: 'item_03' }],
  attachments: [], created_at: '2026-11-17T00:00:00.000Z', updated_at: '2026-11-17T00:00:00.000Z',
};
const login = { ...bank, id: 'item_02', type: 'login', title: 'Example Bank login', fields: { username: 'example' }, relations: [] };
const card = { ...bank, id: 'item_03', type: 'card', title: 'Example Bank card', fields: { last4: '4242' }, relations: [] };

test('export -> import round-trip preserves relations', () => {
  const key = crypto.randomBytes(32);
  const items = [bank, login, card];
  // Export: each item encrypted, relations inside the payload.
  const exported = {
    format: 'my-secrect-vault-export', format_version: 1,
    exported_at: new Date().toISOString(), vault_id: 'vault_1', relations_included: true,
    items: items.map((item, i) => {
      const { nonce, ciphertext } = encrypt(key, JSON.stringify(item));
      return { item_id: item.id, revision: i + 1, encrypted_payload: ciphertext, encrypted_item_key: nonce, encryption_version: 1 };
    }),
  };
  assert.equal(exported.format_version, 1);
  assert.equal(exported.relations_included, true);
  // Import: decrypt each row, relations must come back intact.
  const imported = exported.items.map((row) => JSON.parse(decrypt(key, row.encrypted_item_key, row.encrypted_payload)));
  const back = imported.find((x) => x.id === 'item_01');
  assert.deepEqual(back.relations, bank.relations);
  assert.deepEqual(imported.map((x) => x.id).sort(), ['item_01', 'item_02', 'item_03']);
  // The server-side export contains no plaintext titles or relations.
  const raw = JSON.stringify(exported);
  assert.equal(raw.includes('My Main Bank'), false);
  assert.equal(raw.includes('has_login'), false);
});

test('tampered export payload is rejected, not imported', () => {
  const key = crypto.randomBytes(32);
  const { nonce, ciphertext } = encrypt(key, JSON.stringify(bank));
  const buf = Buffer.from(ciphertext, 'base64');
  buf[0] ^= 1; // flip one ciphertext byte
  assert.throws(() => decrypt(key, nonce, buf.toString('base64')), /unable to authenticate|bad decrypt|Unsupported state/i);
});

test('wrong key cannot decrypt an export row', () => {
  const key = crypto.randomBytes(32);
  const wrong = crypto.randomBytes(32);
  const { nonce, ciphertext } = encrypt(key, JSON.stringify(bank));
  assert.throws(() => decrypt(wrong, nonce, ciphertext));
});
