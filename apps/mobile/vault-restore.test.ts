/**
 * Real mobile vault module on a real SQLite (sql.js) store — the same
 * vault.db schema the app opens through expo-sqlite + SQLCipher.
 * Run: npx tsx --test apps/mobile/vault-restore.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromBase64, toBase64 } from '../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../packages/core/src/types';
import { MemoryKeyValue, openTestStore } from './tests/support/sqljs';
import { SoftwareDeviceKey } from './tests/support/softwareDeviceKey';

const PASSPHRASE = 'correct-horse-battery-staple';
const entry: VaultItem = {
  id: 'item_mobile_01',
  type: 'login',
  schema_version: 1,
  title: 'Mobile restore sentinel',
  fields: { username: 'ada', password: 'mobile-secret', url: 'https://example.test' },
  tags: [],
  relations: [],
  attachments: [],
  favorite: false,
  created_at: '2026-11-17T00:00:00.000Z',
  updated_at: '2026-11-17T00:00:00.000Z',
};

test('mobile: v3 backup restores with recovery key; tampered ciphertext or item list rejected', { timeout: 180_000 }, async () => {
  const vault = await import('./src/vault.ts');
  const { store, raw } = await openTestStore();
  vault.setVaultPlatform({ openStore: async () => store, legacy: new MemoryKeyValue(), deviceKey: new SoftwareDeviceKey() });
  const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all(
    ['vault_keys', 'rows', 'device_unlock', 'autofill_index'].map((t) => raw.all(`SELECT * FROM ${t}`)),
  ));

  const { recoveryKey } = await vault.createVault(PASSPHRASE);
  await vault.unlockVault(PASSPHRASE);
  await vault.upsertItem(entry);
  const backup = await vault.exportEncrypted();
  const doc = JSON.parse(backup) as {
    format_version: number;
    items: Array<{ item_id: string; revision: number; encrypted_payload: string }>;
    item_index?: unknown;
  };
  assert.equal(doc.format_version, 3);

  await vault.wipeVault();
  assert.equal(await store.isOccupied(), false);
  assert.equal(vault.isUnlocked(), false);

  const tampered = structuredClone(doc);
  const bytes = fromBase64(tampered.items[0].encrypted_payload);
  bytes[bytes.length - 1] ^= 0xff;
  tampered.items[0].encrypted_payload = toBase64(bytes);
  const before = await snapshot();
  await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(tampered), { recoveryKey }), /could not decrypt item/);
  assert.equal(await snapshot(), before);
  assert.equal(await store.isOccupied(), false);
  assert.equal(vault.isUnlocked(), false);

  // DEFECT-K2-omission: the only row removed / re-versioned -> item list mismatch, nothing written.
  for (const edit of [(d: typeof doc) => { d.items = []; }, (d: typeof doc) => { d.items[0].revision += 1; }]) {
    const edited = structuredClone(doc);
    edit(edited);
    await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(edited), { recoveryKey }), /restore: item list does not match its authenticated index/);
    assert.equal(await snapshot(), before);
    assert.equal(vault.isUnlocked(), false);
  }

  // Legacy format_version 2 still restores, flagged unverifiable.
  const { item_index: _index, ...legacy } = doc;
  assert.equal(await vault.restoreEncrypted(JSON.stringify({ ...legacy, format_version: 2 }), { recoveryKey }), 'unverifiable-legacy');
  await vault.wipeVault();
  assert.equal(await store.isOccupied(), false);

  assert.equal(await vault.restoreEncrypted(backup, { recoveryKey }), 'verified');
  const got = vault.listItems(true).find((i) => i.id === entry.id);
  assert.ok(got);
  assert.equal(got.title, entry.title);
  assert.deepEqual(got.fields, entry.fields);
  assert.deepEqual(await store.listAutofillIndex(), []); // no biometric unlock on a restored vault yet

  vault.lockVault();
  assert.equal(await vault.unlockVault(PASSPHRASE), true);
  assert.equal(vault.listItems(true).find((i) => i.id === entry.id)?.fields.password, 'mobile-secret');
});
