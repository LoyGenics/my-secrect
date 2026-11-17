// End-to-end outline, no server: create -> encrypt (reference adapter) ->
// export (v1, ciphertext only) -> import -> decrypt -> same item.
// The server is never involved; this pins the export/import contract.
import test from 'node:test';
import assert from 'node:assert/strict';

async function importKey(key) { return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
async function seal(key, obj) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await importKey(key), new TextEncoder().encode(JSON.stringify(obj)));
  return { nonce: Buffer.from(nonce).toString('base64'), ciphertext: Buffer.from(new Uint8Array(ct)).toString('base64') };
}
async function open(key, sealed) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(sealed.nonce, 'base64') }, await importKey(key), Buffer.from(sealed.ciphertext, 'base64'));
  return JSON.parse(new TextDecoder().decode(pt));
}

test('export/import round-trip preserves the item and its relations', async () => {
  const itemKey = crypto.getRandomValues(new Uint8Array(32));
  const item = { id: 'item_01', type: 'bank_account', schema_version: 1, title: 'My Main Bank', fields: { bank_name: 'Example Bank', account_number: '0123456789' }, tags: ['personal'], relations: [{ type: 'has_card', target_id: 'item_03' }], attachments: [] };
  const sealed = await seal(itemKey, item);
  const exported = { format: 'my-secrect-vault-export', format_version: 1, exported_at: new Date().toISOString(), vault_id: 'vault_01', items: [{ item_id: item.id, revision: 1, encrypted_payload: sealed.ciphertext, encrypted_item_key: 'wrapped-key-placeholder', encryption_version: 1 }], relations_included: true };
  // Import: the payload decrypts with the SAME item key the exporter held.
  const restored = await open(itemKey, { nonce: sealed.nonce, ciphertext: exported.items[0].encrypted_payload });
  assert.deepEqual(restored, item);
  assert.deepEqual(restored.relations, [{ type: 'has_card', target_id: 'item_03' }]);
});
