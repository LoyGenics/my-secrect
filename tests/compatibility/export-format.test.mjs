// Compatibility: export format v1 stays readable across versions.
// An export is a list of EncryptedItemVersion rows + a format version;
// a v2 reader must still accept v1 (and reject unknown future versions).
import test from 'node:test';
import assert from 'node:assert/strict';

const SUPPORTED = [1];
function validateExport(doc) {
  if (doc.format !== 'my-secrect-vault-export') throw new Error('bad format');
  if (!SUPPORTED.includes(doc.format_version)) throw new Error(`unsupported format_version ${doc.format_version}`);
  if (!Array.isArray(doc.items)) throw new Error('items must be an array');
  for (const it of doc.items) {
    if (!it.item_id || !it.encrypted_payload || !it.encrypted_item_key) throw new Error('item missing ciphertext fields');
  }
  return true;
}

test('v1 export validates', () => {
  assert.equal(validateExport({ format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1', items: [{ item_id: 'item_01', revision: 1, encrypted_payload: 'AA==', encrypted_item_key: 'BB==', encryption_version: 1 }] }), true);
});
test('unknown future version is rejected, not silently accepted', () => {
  assert.throws(() => validateExport({ format: 'my-secrect-vault-export', format_version: 99, items: [] }), /unsupported/);
});
test('export missing ciphertext is rejected', () => {
  assert.throws(() => validateExport({ format: 'my-secrect-vault-export', format_version: 1, items: [{ item_id: 'x' }] }), /ciphertext/);
});
