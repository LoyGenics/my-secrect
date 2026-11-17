/**
 * createVault must refuse to overwrite an existing vault; the stored keys
 * and ciphertext rows stay byte-identical. Uses the real vault module with an
 * in-memory chrome.storage.local shim (test-only).
 * Run: npx tsx --test apps/extension/vault-ext-create-guard.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map<string, unknown>();
const keyList = (k: string | string[] | null | undefined): string[] =>
  k == null ? [...store.keys()] : Array.isArray(k) ? k : [k];
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(k?: string | string[] | null) {
        const out: Record<string, unknown> = {};
        for (const key of keyList(k)) if (store.has(key)) out[key] = structuredClone(store.get(key));
        return out;
      },
      async set(obj: Record<string, unknown>) {
        for (const [key, v] of Object.entries(obj)) store.set(key, structuredClone(v));
      },
      async remove(k: string | string[]) {
        for (const key of keyList(k)) store.delete(key);
      },
    },
  },
};

test('createVault refuses to overwrite an existing vault', { timeout: 120_000 }, async () => {
  const vault = await import('./src/lib/vault-ext.ts');
  await vault.createVault('first-passphrase-123');
  const before = JSON.stringify([...store.entries()]);
  await assert.rejects(() => vault.createVault('second-passphrase-456'), /already exists/);
  assert.equal(JSON.stringify([...store.entries()]), before);
  assert.equal(await vault.unlockVault('first-passphrase-123'), true);
  // After an explicit wipe a new vault may be created.
  await vault.wipeVault();
  await vault.createVault('second-passphrase-456');
  assert.equal(await vault.unlockVault('second-passphrase-456'), true);
});
