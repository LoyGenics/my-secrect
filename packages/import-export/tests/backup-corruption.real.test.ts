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
import { readFileSync } from 'node:fs';
import {
  ENCRYPTED_EXPORT_FORMAT,
  ENCRYPTED_EXPORT_FORMAT_VERSION,
  EXPORT_KDF_METADATA,
  ITEM_INDEX_HKDF_INFO,
  ITEM_INDEX_MISMATCH,
  LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION,
  buildEncryptedExport,
  itemIndexBytes,
  parseEncryptedExportText,
  sealItemIndex,
  validateEncryptedExport,
  verifyItemIndex,
  type EncryptedExportItem,
  type VaultExport,
  type WrappedKeyEnvelope,
} from '../src/index.ts';
import { libsodiumAdapter, sodiumReady, toBase64, fromBase64 } from '../../crypto-adapters/src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/** A real format_version 3 backup with `n` items (index sealed by the real adapter), plus its legacy v2 twin. */
async function makeBackup(n = 1) {
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
  const items: EncryptedExportItem[] = Array.from({ length: n }, (_, i) => ({
    item_id: `item_${String(i + 1).padStart(2, '0')}`, revision: i + 1, encryption_version: 1,
    encrypted_payload: toBase64(cat(payload.nonce, payload.ciphertext)),
    encrypted_item_key: toBase64(cat(wrappedItemKey.nonce, wrappedItemKey.wrapped)),
  }));
  const itemIndex = await sealItemIndex({ vaultId: 'vault_1', items }, vaultKey, a);
  const doc = buildEncryptedExport({ vaultId: 'vault_1', keys, items, itemIndex });
  const legacy = buildEncryptedExport({ vaultId: 'vault_1', keys, items });
  return { doc, legacy, vaultKey, itemKey };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const errs = (v: { errors: string[] }) => v.errors.join(' | ');
const parsed = (doc: unknown): VaultExport => {
  const r = parseEncryptedExportText(JSON.stringify(doc));
  assert.equal(r.validation.ok, true, errs(r.validation));
  return r.data!;
};

test('valid v3 backup built by real code parses and validates', async () => {
  const { doc } = await makeBackup();
  const r = parseEncryptedExportText(JSON.stringify(doc));
  assert.equal(r.validation.ok, true, errs(r.validation));
  assert.equal(r.validation.formatVersion, ENCRYPTED_EXPORT_FORMAT_VERSION);
  assert.equal(ENCRYPTED_EXPORT_FORMAT_VERSION, 3);
  assert.equal(r.data?.items.length, 1);
  assert.equal(typeof r.data?.item_index?.sealed, 'string');
});

// ---------------------------------------------------------------------------
// Authenticated item index (DEFECT-K2-omission)
// ---------------------------------------------------------------------------

test('item index: an untouched v3 backup verifies, in any row order', async () => {
  const { doc, vaultKey } = await makeBackup(5);
  assert.equal(await verifyItemIndex(parsed(doc), vaultKey, libsodiumAdapter), 'verified');
  const shuffled = clone(doc);
  shuffled.items.reverse();
  assert.equal(await verifyItemIndex(parsed(shuffled), vaultKey, libsodiumAdapter), 'verified');
});

test('item index: a dropped, added or re-versioned row, or a changed vault_id, fails closed', async () => {
  const { doc, vaultKey } = await makeBackup(5);
  const cases: Array<[string, (d: VaultExport) => void]> = [
    ['one item removed', (d) => { d.items.splice(2, 1); }],
    ['all items removed', (d) => { d.items = []; }],
    ['one item added', (d) => { d.items.push({ ...d.items[0], item_id: 'item_99' }); }],
    ['revision rolled back', (d) => { d.items[3].revision = 1; }],
    ['revision bumped', (d) => { d.items[0].revision = 99; }],
    ['item renamed', (d) => { d.items[1].item_id = 'item_02x'; }],
    ['vault_id changed', (d) => { d.vault_id = 'vault_2'; }],
  ];
  for (const [name, mutate] of cases) {
    const d = clone(doc);
    mutate(d);
    await assert.rejects(verifyItemIndex(parsed(d), vaultKey, libsodiumAdapter), new RegExp(ITEM_INDEX_MISMATCH), name);
  }
});

test('item index: a tampered, foreign or swapped index fails closed', async () => {
  const a = await makeBackup(3);
  const b = await makeBackup(2);
  const flipped = clone(a.doc);
  const sealed = fromBase64(flipped.item_index!.sealed);
  sealed[sealed.length - 1] ^= 1;
  flipped.item_index!.sealed = toBase64(sealed);
  await assert.rejects(verifyItemIndex(parsed(flipped), a.vaultKey, libsodiumAdapter), new RegExp(ITEM_INDEX_MISMATCH));
  // Wrong Vault Key (another vault).
  await assert.rejects(verifyItemIndex(parsed(a.doc), b.vaultKey, libsodiumAdapter), new RegExp(ITEM_INDEX_MISMATCH));
  // Same vault, index from a different export of a different item list.
  const smaller = await sealItemIndex({ vaultId: 'vault_1', items: a.doc.items.slice(0, 2) }, a.vaultKey, libsodiumAdapter);
  const dropped = clone(a.doc);
  dropped.items.splice(2, 1);
  assert.equal(await verifyItemIndex(parsed({ ...dropped, item_index: smaller }), a.vaultKey, libsodiumAdapter), 'verified',
    'control: the attacker cannot make this index without the Vault Key');
  await assert.rejects(verifyItemIndex(parsed({ ...a.doc, item_index: smaller }), a.vaultKey, libsodiumAdapter), new RegExp(ITEM_INDEX_MISMATCH));
  // A ciphertext made directly under the Vault Key (not the HKDF index key) does not open as an index.
  const direct = await libsodiumAdapter.encrypt(a.vaultKey, itemIndexBytes(a.doc));
  const forged = { ...clone(a.doc), item_index: { nonce: toBase64(direct.nonce), sealed: toBase64(direct.ciphertext) } };
  await assert.rejects(verifyItemIndex(parsed(forged), a.vaultKey, libsodiumAdapter), new RegExp(ITEM_INDEX_MISMATCH));
});

test('item index: v3 without a well-formed index is rejected before decrypt; v2 is accepted as unverifiable', async () => {
  const { doc, legacy, vaultKey } = await makeBackup(2);
  const { item_index: _drop, ...noIndex } = clone(doc);
  assert.match(errs(validateEncryptedExport(noIndex)), /missing its authenticated item index/);
  assert.match(errs(validateEncryptedExport({ ...clone(doc), item_index: { nonce: 'AAAA', sealed: doc.item_index!.sealed } })), /"item_index" is malformed/);
  assert.match(errs(validateEncryptedExport({ ...clone(doc), item_index: 'x' })), /missing its authenticated item index/);
  const big = clone(doc); big.items[0].revision = 2 ** 53;
  assert.match(errs(validateEncryptedExport(big)), /larger than 2\^53-1/);

  assert.equal(legacy.format_version, LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION);
  assert.equal('item_index' in legacy, false);
  assert.equal(await verifyItemIndex(parsed(legacy), vaultKey, libsodiumAdapter), 'unverifiable-legacy');
  // Downgrade = v2 semantics (restorable, flagged unverifiable) — the UI must say so.
  const downgraded = { ...noIndex, format_version: 2 };
  assert.equal(await verifyItemIndex(parsed(downgraded), vaultKey, libsodiumAdapter), 'unverifiable-legacy');
});

test('item index: canonical bytes match the spec layout (known answer) and the key uses its own HKDF label', async () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const ascii = (s: string) => Buffer.from(s, 'ascii').toString('hex');
  const got = itemIndexBytes({
    format_version: 3,
    vault_id: 'v',
    items: [{ item_id: 'b', revision: 2 ** 32 + 5 }, { item_id: 'a', revision: 1 }],
  });
  const expected =
    '00000017' + ascii('my-secrect-vault-export') + // u32 len + format
    '00000003' + //                                    format_version
    '00000001' + ascii('v') + //                       vault_id
    '00000002' + //                                    count
    '00000001' + ascii('a') + '0000000000000001' + //  sorted by id bytes
    '00000001' + ascii('b') + '0000000100000005';
  assert.equal(hex(got), expected);
  assert.equal(ITEM_INDEX_HKDF_INFO, 'my-secrect/backup-item-index/v1');
  // The label has a Rust-generated cross-implementation vector (tests/crypto-vectors).
  const vectors = JSON.parse(readFileSync(new URL('../../../tests/crypto-vectors/hkdf-vectors.json', import.meta.url), 'utf8'));
  assert.ok(vectors.vectors.some((v: { info: string; length: number }) => v.info === ITEM_INDEX_HKDF_INFO && v.length === 32));
  assert.throws(() => itemIndexBytes({ format_version: 3, vault_id: 'v', items: [{ item_id: 'a\uD800', revision: 1 }] }), /well-formed/);
  assert.throws(() => itemIndexBytes({ format_version: 3, vault_id: 'v', items: [{ item_id: 'a', revision: 2 ** 53 }] }), /revision/);
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
