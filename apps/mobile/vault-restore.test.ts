/**
 * Real mobile vault module. '@react-native-async-storage/async-storage' is
 * replaced by an in-memory shim through a module-load hook that
 * lives only in this file (production code untouched).
 * Run: npx tsx --test apps/mobile/vault-restore.test.ts
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fromBase64, toBase64 } from '../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../packages/core/src/types';

const mem = new Map<string, string>();
(globalThis as unknown as { __asyncStorageShim: unknown }).__asyncStorageShim = {
  async getItem(k: string) { return mem.has(k) ? mem.get(k)! : null; },
  async setItem(k: string, v: string) { mem.set(k, String(v)); },
  async removeItem(k: string) { mem.delete(k); },
};
// apps/mobile has no "type":"module", so tsx loads vault.ts as CJS and the
// bare import goes through Module._load; intercept it there.
const ASYNC_STORAGE = '@react-native-async-storage/async-storage';
const cjs = createRequire(import.meta.url)('node:module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = cjs._load;
cjs._load = function (request: string, ...rest: unknown[]) {
  if (request === ASYNC_STORAGE) {
    const shim = (globalThis as unknown as { __asyncStorageShim: unknown }).__asyncStorageShim;
    return { __esModule: true, default: shim };
  }
  return originalLoad.call(this, request, ...rest);
};

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

const snapshot = (): string => JSON.stringify([...mem.entries()].sort(([a], [b]) => a.localeCompare(b)));

test('mobile: v2 backup restores with recovery key; tampered ciphertext rejected', { timeout: 180_000 }, async () => {
  const vault = await import('./src/vault.ts');
  const { recoveryKey } = await vault.createVault(PASSPHRASE);
  await vault.unlockVault(PASSPHRASE);
  await vault.upsertItem(entry);
  const backup = await vault.exportEncrypted();
  const doc = JSON.parse(backup) as { format_version: number; items: Array<{ encrypted_payload: string }> };
  assert.equal(doc.format_version, 2);

  await vault.wipeVault();
  assert.equal(mem.size, 0);
  assert.equal(vault.isUnlocked(), false);

  const tampered = structuredClone(doc);
  const bytes = fromBase64(tampered.items[0].encrypted_payload);
  bytes[bytes.length - 1] ^= 0xff;
  tampered.items[0].encrypted_payload = toBase64(bytes);
  const before = snapshot();
  await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(tampered), { recoveryKey }), /could not decrypt item/);
  assert.equal(snapshot(), before);
  assert.equal(mem.size, 0);
  assert.equal(vault.isUnlocked(), false);

  await vault.restoreEncrypted(backup, { recoveryKey });
  const got = vault.listItems(true).find((i) => i.id === entry.id);
  assert.ok(got);
  assert.equal(got.title, entry.title);
  assert.deepEqual(got.fields, entry.fields);

  vault.lockVault();
  assert.equal(await vault.unlockVault(PASSPHRASE), true);
  assert.equal(vault.listItems(true).find((i) => i.id === entry.id)?.fields.password, 'mobile-secret');
});
