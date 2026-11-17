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

test('mobile: v2 backup restores with recovery key; tampered ciphertext rejected', { timeout: 180_000 }, async () => {
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
  const doc = JSON.parse(backup) as { format_version: number; items: Array<{ encrypted_payload: string }> };
  assert.equal(doc.format_version, 2);

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

  await vault.restoreEncrypted(backup, { recoveryKey });
  const got = vault.listItems(true).find((i) => i.id === entry.id);
  assert.ok(got);
  assert.equal(got.title, entry.title);
  assert.deepEqual(got.fields, entry.fields);
  assert.deepEqual(await store.listAutofillIndex(), [{ id: entry.id, title: entry.title, username: 'ada', host: 'example.test', type: 'login' }]);

  vault.lockVault();
  assert.equal(await vault.unlockVault(PASSPHRASE), true);
  assert.equal(vault.listItems(true).find((i) => i.id === entry.id)?.fields.password, 'mobile-secret');
});
