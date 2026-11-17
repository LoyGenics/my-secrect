/**
 * Real extension vault module + in-memory chrome.storage.local shim (defined
 * only here). Export v2 backup, restore into an empty store with the recovery
 * key, round-trip one item; tampered ciphertext is rejected, storage unchanged.
 * Run: npx tsx --test apps/extension/vault-ext-restore.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromBase64, toBase64 } from '../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../packages/core/src/types';

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

const PASSPHRASE = 'correct-horse-battery-staple';
const entry: VaultItem = {
  id: 'item_ext_01',
  type: 'login',
  schema_version: 1,
  title: 'Extension restore sentinel',
  fields: { username: 'ada', password: 'ext-secret', url: 'https://example.test' },
  tags: [],
  relations: [],
  attachments: [],
  favorite: false,
  created_at: '2026-11-17T00:00:00.000Z',
  updated_at: '2026-11-17T00:00:00.000Z',
};

function snapshot(): string {
  return JSON.stringify([...store.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

test('extension: v3 backup restores with recovery key; tampered ciphertext or item list rejected', { timeout: 180_000 }, async () => {
  const vault = await import('./src/lib/vault-ext.ts');
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
  assert.equal(store.size, 0);
  assert.equal(vault.isUnlocked(), false);

  const tampered = structuredClone(doc);
  const bytes = fromBase64(tampered.items[0].encrypted_payload);
  bytes[bytes.length - 1] ^= 0xff;
  tampered.items[0].encrypted_payload = toBase64(bytes);
  const before = snapshot();
  await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(tampered), { recoveryKey }), /could not decrypt item/);
  assert.equal(snapshot(), before);
  assert.equal(store.size, 0);
  assert.equal(vault.isUnlocked(), false);

  // DEFECT-K2-omission: the only row removed / re-versioned -> item list mismatch, nothing written.
  for (const edit of [(d: typeof doc) => { d.items = []; }, (d: typeof doc) => { d.items[0].revision += 1; }]) {
    const edited = structuredClone(doc);
    edit(edited);
    await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(edited), { recoveryKey }), /restore: item list does not match its authenticated index/);
    assert.equal(snapshot(), before);
    assert.equal(vault.isUnlocked(), false);
  }

  // Legacy format_version 2 still restores, flagged unverifiable.
  const { item_index: _index, ...legacy } = doc;
  assert.equal(await vault.restoreEncrypted(JSON.stringify({ ...legacy, format_version: 2 }), { recoveryKey }), 'unverifiable-legacy');
  await vault.wipeVault();
  assert.equal(store.size, 0);

  assert.equal(await vault.restoreEncrypted(backup, { recoveryKey }), 'verified');
  const got = vault.listUnlockedItems().find((i) => i.id === entry.id);
  assert.ok(got);
  assert.equal(got.title, entry.title);
  assert.deepEqual(got.fields, entry.fields);

  vault.lockVault();
  assert.equal(await vault.unlockVault(PASSPHRASE), true);
  assert.equal(vault.listUnlockedItems().find((i) => i.id === entry.id)?.fields.password, 'ext-secret');
});
