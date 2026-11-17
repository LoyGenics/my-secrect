// REAL-MODULE test: corrupted / tampered encrypted backup handling.
//
// Imports the production validator/parser from packages/import-export and
// the production libsodium adapter from packages/crypto-adapters. Nothing
// is re-implemented here. Replaces the old mirror
// tests/security/backup-corruption.test.mjs (backup format v1).
//
// Scope limit: validateEncryptedExport is structural only. Whether a
// backup's vault_id matches a target vault is enforced in the vault
// restore code (covered by apps/*/…restore tests), not here.
//
// Run: npm test (tsx --test, Node 20)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENCRYPTED_EXPORT_FORMAT,
  ENCRYPTED_EXPORT_FORMAT_VERSION,
  EXPORT_KDF_METADATA,
  buildEncryptedExport,
  parseEncryptedExportText,
  validateEncryptedExport,
  type EncryptedExportItem,
  type WrappedKeyEnvelope,
} from '../src/index.ts';
import { libsodiumAdapter, sodiumReady, toBase64, fromBase64 } from '../../crypto-adapters/src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

async function makeBackup() {
  await sodiumReady;
  const a = libsodiumAdapter;
  const vaultKey = a.randomBytes(32);
  const itemKey = a.randomBytes(32);
  const payload = await a.encrypt(itemKey, enc.encode('my password'));
  const wrappedItemKey = await a.wrapKey(vaultKey, itemKey);
  const wm = await a.wrapKey(a.randomBytes(32), a.randomBytes(32));
  const wv = await a.wrapKey(a.randomBytes(32), vaultKey);
  const wr = await a.wrapKey(a.randomBytes(32), a.randomBytes(32));
  const keys: WrappedKeyEnvelope = {
    salt: toBase64(a.randomBytes(16)),
    wrapped_master: toBase64(wm.wrapped), wrapped_master_nonce: toBase64(wm.nonce),
    wrapped_vault: toBase64(wv.wrapped), wrapped_vault_nonce: toBase64(wv.nonce),
    wrapped_recovery: toBase64(wr.wrapped), wrapped_recovery_nonce: toBase64(wr.nonce),
  };
  const item: EncryptedExportItem = {
    item_id: 'item_01', revision: 1, encryption_version: 1,
    encrypted_payload: toBase64(cat(payload.nonce, payload.ciphertext)),
    encrypted_item_key: toBase64(cat(wrappedItemKey.nonce, wrappedItemKey.wrapped)),
  };
  const doc = buildEncryptedExport({ vaultId: 'vault_1', keys, items: [item] });
  return { doc, vaultKey, itemKey };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const errs = (v: { errors: string[] }) => v.errors.join(' | ');

test('valid v2 backup built by real code parses and validates', async () => {
  const { doc } = await makeBackup();
  const r = parseEncryptedExportText(JSON.stringify(doc));
  assert.equal(r.validation.ok, true, errs(r.validation));
  assert.equal(r.validation.formatVersion, ENCRYPTED_EXPORT_FORMAT_VERSION);
  assert.equal(r.data?.items.length, 1);
});

test('not JSON / truncated file is rejected with data null', async () => {
  const { doc } = await makeBackup();
  const full = JSON.stringify(doc);
  for (const text of ['{not json', '', full.slice(0, 10), full.slice(0, full.length >> 1), full.slice(0, -3)]) {
    const r = parseEncryptedExportText(text);
    assert.equal(r.validation.ok, false);
    assert.equal(r.data, null);
    assert.match(errs(r.validation), /not valid JSON/);
  }
});

test('format_version 1 backup is rejected (no key envelope)', async () => {
  const { doc } = await makeBackup();
  const v1 = { ...clone(doc), format_version: 1 };
  const r = validateEncryptedExport(v1);
  assert.equal(r.ok, false);
  assert.equal(r.formatVersion, 1);
  assert.match(errs(r), /format_version 1/);
  assert.match(errs(r), /no wrapped key envelope/);
});

test('newer / zero / non-integer format_version is rejected', async () => {
  const { doc } = await makeBackup();
  const newer = validateEncryptedExport({ ...clone(doc), format_version: 99 });
  assert.equal(newer.ok, false);
  assert.match(errs(newer), /newer version/);
  const zero = validateEncryptedExport({ ...clone(doc), format_version: 0 });
  assert.equal(zero.ok, false);
  assert.match(errs(zero), /Unsupported export version/);
  const frac = validateEncryptedExport({ ...clone(doc), format_version: 2.5 });
  assert.equal(frac.ok, false);
  const missing = clone(doc) as Record<string, unknown>;
  delete missing.format_version;
  assert.equal(validateEncryptedExport(missing).ok, false);
});

test('wrong format string and plaintext export are rejected', async () => {
  const { doc } = await makeBackup();
  assert.match(errs(validateEncryptedExport({ ...clone(doc), format: 'other-app-export' })), /Not a my-secrect/);
  assert.match(errs(validateEncryptedExport({ ...clone(doc), format: 'my-secrect-vault-plaintext-export' })), /plaintext export/);
  assert.equal(validateEncryptedExport(null).ok, false);
  assert.equal(validateEncryptedExport([]).ok, false);
});

test('v2 envelope validation: missing/short keys, bad kdf, missing vault_id', async () => {
  const { doc } = await makeBackup();
  const noKeys = clone(doc) as Record<string, unknown>;
  delete noKeys.keys;
  assert.match(errs(validateEncryptedExport(noKeys)), /wrapped key envelope/);

  const shortField = clone(doc);
  shortField.keys.wrapped_vault = toBase64(new Uint8Array(10));
  assert.match(errs(validateEncryptedExport(shortField)), /wrapped_vault/);

  const badSalt = clone(doc);
  badSalt.keys.salt = '!!!not-base64!!!';
  assert.match(errs(validateEncryptedExport(badSalt)), /salt/);

  const badKdf = clone(doc) as { kdf: Record<string, unknown> };
  badKdf.kdf.opslimit = 1;
  assert.match(errs(validateEncryptedExport(badKdf)), /kdf\.opslimit/);
  const noKdf = clone(doc) as Record<string, unknown>;
  delete noKdf.kdf;
  assert.match(errs(validateEncryptedExport(noKdf)), /kdf/);
  assert.equal(EXPORT_KDF_METADATA.name, 'argon2id');

  const noVault = clone(doc) as Record<string, unknown>;
  delete noVault.vault_id;
  assert.match(errs(validateEncryptedExport(noVault)), /vault_id/);

  const noRel = { ...clone(doc), relations_included: false };
  assert.match(errs(validateEncryptedExport(noRel)), /relations_included/);
});

test('item validation: missing fields, bad base64, wrong lengths, bad encryption_version', async () => {
  const { doc } = await makeBackup();
  const mut = (fn: (item: Record<string, unknown>) => void) => {
    const d = clone(doc);
    fn(d.items[0] as unknown as Record<string, unknown>);
    return validateEncryptedExport(d);
  };
  assert.match(errs(mut((i) => { delete i.item_id; })), /item_id/);
  assert.match(errs(mut((i) => { delete i.encrypted_payload; })), /encrypted_payload/);
  assert.match(errs(mut((i) => { delete i.encrypted_item_key; })), /encrypted_item_key/);
  assert.match(errs(mut((i) => { i.encrypted_payload = '!!!not-base64!!!'; })), /encrypted_payload/);
  assert.match(errs(mut((i) => { i.encrypted_item_key = toBase64(new Uint8Array(10)); })), /encrypted_item_key/);
  assert.match(errs(mut((i) => { i.encrypted_payload = toBase64(new Uint8Array(8)); })), /encrypted_payload/);
  assert.match(errs(mut((i) => { i.encryption_version = 2; })), /encryption_version/);
  assert.match(errs(mut((i) => { i.revision = -1; })), /revision/);
});

test('duplicate item ids are rejected, not silently overwritten', async () => {
  const { doc } = await makeBackup();
  const d = clone(doc);
  d.items.push(clone(d.items[0]));
  const r = validateEncryptedExport(d);
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicateIds, ['item_01']);
  assert.match(errs(r), /duplicate/);
});

test('tampered ciphertext passes structural validation but fails real AEAD decrypt', async () => {
  const { doc, itemKey } = await makeBackup();
  const d = clone(doc);
  const raw = fromBase64(d.items[0].encrypted_payload);
  raw[raw.length - 1] ^= 1; // flip a bit in the tag region
  d.items[0].encrypted_payload = toBase64(raw);
  // Well-formed base64 of the right shape: the structural check cannot see this.
  assert.equal(validateEncryptedExport(d).ok, true);
  const nonce = raw.slice(0, 24);
  const ct = raw.slice(24);
  await assert.rejects(() => libsodiumAdapter.decrypt(itemKey, nonce, ct));
  // Untampered original still decrypts: the backup itself is intact.
  const orig = fromBase64(doc.items[0].encrypted_payload);
  assert.equal(dec.decode(await libsodiumAdapter.decrypt(itemKey, orig.slice(0, 24), orig.slice(24))), 'my password');
});

test('wrong key / tampered wrapped item key fails real unwrap', async () => {
  const { doc, vaultKey, itemKey } = await makeBackup();
  const blob = fromBase64(doc.items[0].encrypted_item_key);
  const nonce = blob.slice(0, 24);
  const wrapped = blob.slice(24);
  // Right vault key unwraps to the item key.
  assert.deepEqual(await libsodiumAdapter.unwrapKey(vaultKey, nonce, wrapped), itemKey);
  // Wrong wrapping key rejects.
  await assert.rejects(() => libsodiumAdapter.unwrapKey(libsodiumAdapter.randomBytes(32), nonce, wrapped));
  // Tampered wrapped key rejects.
  const bad = wrapped.slice();
  bad[0] ^= 1;
  await assert.rejects(() => libsodiumAdapter.unwrapKey(vaultKey, nonce, bad));
});
