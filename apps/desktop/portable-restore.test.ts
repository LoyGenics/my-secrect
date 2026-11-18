/**
 * Real portable restore: vault A export, empty vault B, recovery key.
 * Run: npx tsx --test apps/desktop/portable-restore.test.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fromBase64, toBase64 } from '../../packages/crypto-adapters/src/index';
import { EXPORT_KDF_METADATA, validateEncryptedExport } from '../../packages/import-export/src/index';
import type { VaultItem } from '../../packages/core/src/types';

const LS_KEY = 'my-secrect.local-vault.v1';
const LS_KEYS = 'my-secrect.local-vault.v1.keys';
const PASSPHRASE = 'correct-horse-battery-staple';
const SECRET = 'portable-restore-secret-value';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem(key: string): string | null {
      return mem.has(key) ? mem.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      mem.set(key, String(value));
    },
    removeItem(key: string): void {
      mem.delete(key);
    },
    clear(): void {
      mem.clear();
    },
    key(index: number): string | null {
      return [...mem.keys()][index] ?? null;
    },
    get length(): number {
      return mem.size;
    },
  },
  configurable: true,
  writable: true,
});

function flipLastByte(encoded: string): string {
  const bytes = fromBase64(encoded);
  bytes[bytes.length - 1] ^= 0xff;
  return toBase64(bytes);
}

function item(id: string, title: string): VaultItem {
  return {
    id,
    type: 'login',
    schema_version: 1,
    title,
    fields: { username: 'ada', password: SECRET, url: 'https://example.test' },
    tags: ['restore'],
    relations: [],
    attachments: [],
    favorite: false,
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
  };
}

function visible(entry: VaultItem) {
  return {
    id: entry.id,
    type: entry.type,
    schema_version: entry.schema_version,
    title: entry.title,
    fields: entry.fields,
    tags: entry.tags,
  };
}

function assertStorageEmpty(): void {
  assert.equal(localStorage.getItem(LS_KEYS), null);
  assert.equal(localStorage.getItem(LS_KEY), null);
}

test('a batch import commits no rows when a later item cannot be encrypted', { timeout: 180_000 }, async () => {
  const vault = await import('./src/vault.ts');
  localStorage.clear();
  await vault.createVault(PASSPHRASE);
  const originalRows = localStorage.getItem(LS_KEY);
  const malformed = item('item_bad', 'Broken item');
  malformed.fields.circular = malformed.fields;
  await assert.rejects(vault.upsertItems([item('item_good', 'First item'), malformed]), /circular/i);
  assert.deepEqual(vault.listItems(), []);
  assert.equal(localStorage.getItem(LS_KEY), originalRows);
  vault.lockVault();
  localStorage.clear();
});

test('portable v3 restore uses the frozen item cipher', { timeout: 180_000 }, async () => {
  const vault = await import('./src/vault.ts');
  const first = item('item_restore_01', 'Portable restore sentinel');
  const second = item('item_restore_02', 'Portable restore second');
  const { recoveryKey } = await vault.createVault(PASSPHRASE);
  await vault.upsertItem(first);
  await vault.upsertItem(second);
  const backup = await vault.exportEncrypted();
  const doc = JSON.parse(backup) as {
    format: string;
    format_version: number;
    kdf: typeof EXPORT_KDF_METADATA;
    keys: Record<string, string>;
    items: Array<{ item_id: string; revision: number; encrypted_payload: string; encrypted_item_key: string; encryption_version: number }>;
    item_index?: { nonce: string; sealed: string };
  };

  assert.equal(doc.format, 'my-secrect-vault-export');
  assert.equal(doc.format_version, 3);
  assert.equal(typeof doc.item_index?.sealed, 'string');
  assert.deepEqual(doc.kdf, EXPORT_KDF_METADATA);
  assert.equal(doc.kdf.name, 'argon2id');
  assert.equal(doc.kdf.opslimit, 2);
  assert.equal(doc.kdf.memlimit, 67108864);
  assert.equal(validateEncryptedExport(doc).ok, true);
  assert.equal(doc.items.length, 2);
  assert.ok(doc.items.every((row) => row.encryption_version === 1));
  assert.equal(backup.includes(PASSPHRASE), false);
  assert.equal(backup.includes(recoveryKey), false);
  assert.equal(backup.includes(SECRET), false);
  assert.equal(backup.includes(first.title), false);

  const snapKeys = localStorage.getItem(LS_KEYS);
  const snapRows = localStorage.getItem(LS_KEY);
  const partial = structuredClone(doc);
  partial.items[0].revision = 99;
  partial.items[1].encrypted_payload = flipLastByte(partial.items[1].encrypted_payload);
  await assert.rejects(() => vault.importEncrypted(JSON.stringify(partial)), /could not decrypt item/);
  assert.equal(localStorage.getItem(LS_KEYS), snapKeys);
  assert.equal(localStorage.getItem(LS_KEY), snapRows);
  assert.equal(vault.listItems(true).length, 2);

  const idBad = structuredClone(doc);
  idBad.items[0].item_id = 'item_not_in_plaintext';
  idBad.items[0].revision = 99;
  await assert.rejects(() => vault.importEncrypted(JSON.stringify(idBad)), /does not match item_id/);
  assert.equal(localStorage.getItem(LS_KEYS), snapKeys);
  assert.equal(localStorage.getItem(LS_KEY), snapRows);

  // Authentic rows, but the list was edited: re-versioned (rollback/bump) or one row dropped.
  const bumped = structuredClone(doc);
  bumped.items[0].revision = 99;
  await assert.rejects(() => vault.importEncrypted(JSON.stringify(bumped)), /import: item list does not match its authenticated index/);
  const droppedImport = structuredClone(doc);
  droppedImport.items.splice(1, 1);
  await assert.rejects(() => vault.importEncrypted(JSON.stringify(droppedImport)), /import: item list does not match its authenticated index/);
  assert.equal(localStorage.getItem(LS_KEYS), snapKeys);
  assert.equal(localStorage.getItem(LS_KEY), snapRows);
  assert.equal(await vault.importEncrypted(backup), 'verified');

  vault.wipeVault();
  assertStorageEmpty();
  assert.equal(vault.isUnlocked(), false);

  const v1 = JSON.stringify({
    format: 'my-secrect-vault-export',
    format_version: 1,
    exported_at: '2026-11-17T00:00:00.000Z',
    vault_id: 'local',
    items: doc.items,
    relations_included: true,
  });
  await assert.rejects(() => vault.restoreEncrypted(v1, { recoveryKey }), /format_version 1/);
  assertStorageEmpty();
  assert.deepEqual(vault.listItems(true), []);

  const weakened = structuredClone(doc);
  weakened.kdf = { ...weakened.kdf, opslimit: 1 };
  await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(weakened), { recoveryKey }), /kdf\.opslimit/);
  assertStorageEmpty();

  const { keys: _keys, ...withoutEnvelope } = doc;
  await assert.rejects(
    () => vault.restoreEncrypted(JSON.stringify(withoutEnvelope), { recoveryKey }),
    /wrapped key envelope/,
  );
  assertStorageEmpty();

  // One authentic row removed from the file: detected, nothing written.
  const dropped = structuredClone(doc);
  dropped.items.splice(0, 1);
  await assert.rejects(
    () => vault.restoreEncrypted(JSON.stringify(dropped), { recoveryKey }),
    /restore: item list does not match its authenticated index/,
  );
  assertStorageEmpty();
  assert.equal(vault.isUnlocked(), false);

  // A legacy format_version 2 file (no index) still restores, flagged unverifiable.
  const { item_index: _index, ...legacyBody } = doc;
  assert.equal(await vault.restoreEncrypted(JSON.stringify({ ...legacyBody, format_version: 2 }), { recoveryKey }), 'unverifiable-legacy');
  vault.wipeVault();
  assertStorageEmpty();

  assert.equal(await vault.restoreEncrypted(backup, { recoveryKey }), 'verified');
  const restored = vault.listItems(true);
  assert.deepEqual(restored.map(visible).sort((a, b) => a.id.localeCompare(b.id)), [visible(first), visible(second)]);
  assert.deepEqual(JSON.parse(localStorage.getItem(LS_KEYS) ?? 'null'), doc.keys);
  assert.equal(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]').length, 2);

  vault.lockVault();
  assert.equal(vault.isUnlocked(), false);
  assert.equal(await vault.unlockVault(PASSPHRASE), true);
  assert.deepEqual(
    vault.listItems(true).map(visible).sort((a, b) => a.id.localeCompare(b.id)),
    [visible(first), visible(second)],
  );

  vault.lockVault();
  const storedRows = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Array<{ id: string }>;
  storedRows[0].id = 'row_id_mismatch';
  localStorage.setItem(LS_KEY, JSON.stringify(storedRows));
  assert.equal(await vault.unlockWithRecoveryKey(recoveryKey), false);
  assert.equal(vault.isUnlocked(), false);
  assert.deepEqual(vault.listItems(true), []);
  assert.equal(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')[0].id, 'row_id_mismatch');

  vault.wipeVault();
  assertStorageEmpty();
  const wrongRecovery = randomBytes(32).toString('base64url');
  await assert.rejects(() => vault.restoreEncrypted(backup, { recoveryKey: wrongRecovery }), /recovery key/);
  assertStorageEmpty();
  assert.equal(vault.isUnlocked(), false);
  assert.deepEqual(vault.listItems(true), []);

  const tampered = structuredClone(doc);
  tampered.items[1].encrypted_payload = flipLastByte(tampered.items[1].encrypted_payload);
  await assert.rejects(
    () => vault.restoreEncrypted(JSON.stringify(tampered), { recoveryKey }),
    /could not decrypt item/,
  );
  assertStorageEmpty();
  assert.deepEqual(vault.listItems(true), []);

  const mismatched = structuredClone(doc);
  mismatched.items[0].item_id = 'item_not_in_plaintext';
  await assert.rejects(
    () => vault.restoreEncrypted(JSON.stringify(mismatched), { recoveryKey }),
    /does not match item_id/,
  );
  assertStorageEmpty();

  await vault.restoreEncrypted(backup, { passphrase: PASSPHRASE });
  assert.deepEqual(
    vault.listItems(true).map(visible).sort((a, b) => a.id.localeCompare(b.id)),
    [visible(first), visible(second)],
  );
  assert.deepEqual(JSON.parse(localStorage.getItem(LS_KEYS) ?? 'null'), doc.keys);
});
