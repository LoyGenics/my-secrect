/**
 * Restore guards against the real desktop vault module: non-empty storage is
 * rejected untouched, and a flipped wrapped_vault byte fails with storage empty.
 * Run: npx tsx --test apps/desktop/portable-restore-guards.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromBase64, toBase64 } from '../../packages/crypto-adapters/src/index';
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

function assertStorageEmpty(): void {
  assert.equal(localStorage.getItem(LS_KEYS), null);
  assert.equal(localStorage.getItem(LS_KEY), null);
}

function flipFirstByte(encoded: string): string {
  const bytes = fromBase64(encoded);
  bytes[0] ^= 0x01;
  return toBase64(bytes);
}

function snapshot(): Array<[string, string]> {
  return [...mem.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const entry: VaultItem = {
  id: 'item_guard_01',
  type: 'login',
  schema_version: 1,
  title: 'Guard sentinel',
  fields: { username: 'ada', password: 'guard-secret', url: 'https://example.test' },
  tags: [],
  relations: [],
  attachments: [],
  favorite: false,
  created_at: '2026-11-17T00:00:00.000Z',
  updated_at: '2026-11-17T00:00:00.000Z',
};

test('restore guards: non-empty storage rejected unchanged; flipped wrapped_vault fails', { timeout: 180_000 }, async () => {
  const vault = await import('./src/vault.ts');
  const { recoveryKey } = await vault.createVault(PASSPHRASE);
  await vault.upsertItem(entry);
  const backup = vault.exportEncrypted();
  const realKeys = localStorage.getItem(LS_KEYS)!;
  const realRows = localStorage.getItem(LS_KEY)!;

  // (a) occupied storage: full vault, keys only, rows only.
  const occupied: Array<[string | null, string | null]> = [
    [realKeys, realRows],
    [realKeys, null],
    [null, realRows],
  ];
  for (const [k, r] of occupied) {
    vault.wipeVault();
    if (k !== null) localStorage.setItem(LS_KEYS, k);
    if (r !== null) localStorage.setItem(LS_KEY, r);
    const before = snapshot();
    await assert.rejects(
      () => vault.restoreEncrypted(backup, { recoveryKey }),
      (err: Error) => err.message === 'restore: vault storage is not empty',
    );
    assert.deepEqual(snapshot(), before);
  }

  // (b) valid v2 file, one wrapped_vault byte flipped.
  vault.wipeVault();
  assertStorageEmpty();
  const doc = JSON.parse(backup) as { format_version: number; keys: Record<string, string> };
  assert.equal(doc.format_version, 2);
  const bad = structuredClone(doc);
  bad.keys.wrapped_vault = flipFirstByte(bad.keys.wrapped_vault);
  assert.notEqual(bad.keys.wrapped_vault, doc.keys.wrapped_vault);
  await assert.rejects(() => vault.restoreEncrypted(JSON.stringify(bad), { recoveryKey }));
  assertStorageEmpty();
  assert.equal(vault.isUnlocked(), false);
  assert.deepEqual(vault.listItems(true), []);
});
