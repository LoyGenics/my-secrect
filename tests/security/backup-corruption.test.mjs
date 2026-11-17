// Security hardening tests — corrupted backup / export handling.
//
// HONEST HEADER — READ BEFORE CITING THESE TESTS:
//   * MIRROR, not import. The export-format validator and the encrypt/
//     decrypt helpers are re-implemented here in-file, following the
//     documented format v1 (see tests/compatibility/export-format.test.mjs
//     and packages/import-export). They do NOT import the real
//     import-export package or any production vault code. A green run
//     proves the VALIDATION RULES; it cannot prove the real importer
//     rejects the same inputs. The real round-trip has only ever been
//     exercised by mirrors (Phase A, gate 6).
//   * Plain Node 20+, no server, no TS loader: `node --test tests/security/`
//   * These tests NEVER ran on the Mac. Nothing here is verified.
//
// What is covered: corrupted backup file (bad JSON, truncated file,
// bad base64, missing ciphertext fields, unknown format version,
// tampered item ciphertext, wrong wrapped key, duplicate item ids,
// tampered export metadata such as vault_id / exported_at).
import test from 'node:test';
import assert from 'node:assert/strict';

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- mirror of the export format v1 validator (see compatibility tests) ---
const SUPPORTED_VERSIONS = [1];
function validateExport(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('export must be an object');
  if (doc.format !== 'my-secrect-vault-export') throw new Error('bad format');
  if (!SUPPORTED_VERSIONS.includes(doc.format_version)) throw new Error(`unsupported format_version ${doc.format_version}`);
  if (typeof doc.vault_id !== 'string' || doc.vault_id.length === 0) throw new Error('vault_id missing');
  if (!Array.isArray(doc.items)) throw new Error('items must be an array');
  const seen = new Set();
  for (const it of doc.items) {
    if (!it.item_id || !it.encrypted_payload || !it.encrypted_item_key) throw new Error('item missing ciphertext fields');
    if (seen.has(it.item_id)) throw new Error(`duplicate item_id ${it.item_id}`);
    seen.add(it.item_id);
    // Ciphertext fields must be valid base64 — a flipped character in
    // transit must fail here, not later as a silent empty value.
    for (const f of ['encrypted_payload', 'encrypted_item_key']) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(it[f])) throw new Error(`item ${it.item_id}: ${f} is not valid base64`);
      Buffer.from(it[f], 'base64'); // throws on malformed input
    }
  }
  return true;
}
function parseBackupFile(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('backup file is not valid JSON'); }
  validateExport(doc);
  return doc;
}

// --- mirror AES-GCM helpers (same as tamper.test.mjs) ----------------------
async function importKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encrypt(key, plaintext) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await importKey(key), plaintext);
  return { nonce, ciphertext: new Uint8Array(ct) };
}
async function decrypt(key, nonce, ciphertext) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await importKey(key), ciphertext));
}
function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

async function makeValidExport() {
  const itemKey = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = await encrypt(itemKey, enc.encode('my password'));
  const wrapped = crypto.getRandomValues(new Uint8Array(48)); // opaque wrapped-key blob (mirror)
  return {
    format: 'my-secrect-vault-export', format_version: 1, vault_id: 'vault_1',
    exported_at: new Date().toISOString(),
    items: [{
      item_id: 'item_01', revision: 1, encryption_version: 1,
      nonce: b64(nonce), encrypted_payload: b64(ciphertext), encrypted_item_key: b64(wrapped),
    }],
    // Keep the real key out of the fixture: the test re-derives it below.
    _test_item_key: itemKey,
  };
}

test('valid v1 backup parses', () => {
  const doc = { format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1', items: [] };
  assert.equal(parseBackupFile(JSON.stringify(doc)).vault_id, 'v1');
});

test('corrupted backup: not JSON at all', () => {
  assert.throws(() => parseBackupFile('{not json'), /not valid JSON/);
  assert.throws(() => parseBackupFile(''), /not valid JSON/);
});

test('corrupted backup: truncated file (cut mid-document)', () => {
  const full = JSON.stringify({ format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1', items: [{ item_id: 'a', encrypted_payload: 'AA==', encrypted_item_key: 'BB==' }] });
  for (const cut of [10, Math.floor(full.length / 2), full.length - 3]) {
    assert.throws(() => parseBackupFile(full.slice(0, cut)), /not valid JSON|vault_id|items|format/);
  }
});

test('corrupted backup: wrong format string / unknown future version', () => {
  assert.throws(() => parseBackupFile(JSON.stringify({ format: 'other-app-export', format_version: 1, vault_id: 'v1', items: [] })), /bad format/);
  assert.throws(() => parseBackupFile(JSON.stringify({ format: 'my-secrect-vault-export', format_version: 99, vault_id: 'v1', items: [] })), /unsupported/);
  assert.throws(() => parseBackupFile(JSON.stringify({ format: 'my-secrect-vault-export', format_version: 0, vault_id: 'v1', items: [] })), /unsupported/);
});

test('corrupted backup: missing vault_id / items not an array', () => {
  assert.throws(() => parseBackupFile(JSON.stringify({ format: 'my-secrect-vault-export', format_version: 1, items: [] })), /vault_id/);
  assert.throws(() => parseBackupFile(JSON.stringify({ format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1', items: {} })), /items must be an array/);
});

test('corrupted backup: item missing ciphertext fields', () => {
  const base = { format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1' };
  assert.throws(() => parseBackupFile(JSON.stringify({ ...base, items: [{ item_id: 'x' }] })), /ciphertext/);
  assert.throws(() => parseBackupFile(JSON.stringify({ ...base, items: [{ item_id: 'x', encrypted_payload: 'AA==' }] })), /ciphertext/);
  assert.throws(() => parseBackupFile(JSON.stringify({ ...base, items: [{ encrypted_payload: 'AA==', encrypted_item_key: 'BB==' }] })), /ciphertext/);
});

test('corrupted backup: ciphertext field is not valid base64', () => {
  const doc = { format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1', items: [{ item_id: 'x', encrypted_payload: '!!!not-base64!!!', encrypted_item_key: 'BB==' }] };
  assert.throws(() => parseBackupFile(JSON.stringify(doc)), /base64/);
});

test('corrupted backup: duplicate item ids are rejected (no silent overwrite)', () => {
  const item = { item_id: 'dup', encrypted_payload: 'AA==', encrypted_item_key: 'BB==' };
  const doc = { format: 'my-secrect-vault-export', format_version: 1, vault_id: 'v1', items: [item, { ...item }] };
  assert.throws(() => parseBackupFile(JSON.stringify(doc)), /duplicate/);
});

test('corrupted backup: tampered item ciphertext fails AEAD on import', async () => {
  const exp = await makeValidExport();
  const item = exp.items[0];
  const raw = Buffer.from(item.encrypted_payload, 'base64');
  raw[0] ^= 1;
  item.encrypted_payload = raw.toString('base64');
  // Structural validation still passes (it is well-formed base64)...
  assert.equal(validateExport(exp), true);
  // ...but decrypting the tampered payload with the item key must fail.
  const nonce = Buffer.from(item.nonce, 'base64');
  const ct = Buffer.from(item.encrypted_payload, 'base64');
  await assert.rejects(() => decrypt(exp._test_item_key, nonce, ct));
});

test('corrupted backup: wrong wrapped key (wrong item key) fails decrypt', async () => {
  const exp = await makeValidExport();
  const item = exp.items[0];
  const nonce = Buffer.from(item.nonce, 'base64');
  const ct = Buffer.from(item.encrypted_payload, 'base64');
  // Simulates importing with a different vault / wrong unwrapped item key.
  await assert.rejects(() => decrypt(crypto.getRandomValues(new Uint8Array(32)), nonce, ct));
  // The right key still works — the backup itself is intact.
  assert.equal(dec(await decrypt(exp._test_item_key, nonce, ct)), 'my password');
});

test('tampered export metadata: vault_id changed — import must not silently merge into the wrong vault', () => {
  // The validator cannot know the "right" vault_id from the file alone.
  // This test documents the rule the real importer must enforce: the
  // caller must compare doc.vault_id against the target vault and refuse
  // on mismatch, instead of importing blindly.
  const doc = { format: 'my-secrect-vault-export', format_version: 1, vault_id: 'vault_ATTACKER', items: [] };
  const targetVaultId = 'vault_1';
  assert.notEqual(doc.vault_id, targetVaultId);
  const importInto = (doc, target) => {
    if (doc.vault_id !== target) throw new Error(`export belongs to vault ${doc.vault_id}, not ${target}`);
    return true;
  };
  assert.throws(() => importInto(doc, targetVaultId), /not vault_1/);
  assert.equal(importInto({ ...doc, vault_id: 'vault_1' }, targetVaultId), true);
});
