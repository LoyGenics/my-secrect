/**
 * Real extension vault module + in-memory chrome.storage.local shim (defined
 * only here). Recovery-key unlock accepts exactly 32 decoded bytes and zeroes
 * them after use, like desktop (apps/desktop/src/vault.ts).
 * Run: npx tsx --test apps/extension/tests/vault-ext-recovery.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { toBase64Url } from '../../../packages/crypto-adapters/src/index';

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

const PASSPHRASE = 'recovery-test-passphrase-fixture';

test('withRecoveryKeyBytes: 32 bytes are handed over then zeroed; 31 or 33 bytes never reach the caller', async () => {
  const { withRecoveryKeyBytes } = await import('../src/lib/vault-ext.ts');
  const key = toBase64Url(new Uint8Array(randomBytes(32)));
  let seen: Uint8Array | null = null;
  const copy = await withRecoveryKeyBytes(`  ${key}\n`, async (bytes) => {
    seen = bytes;
    return Array.from(bytes);
  });
  assert.equal(copy.length, 32);
  assert.ok(copy.some((b) => b !== 0));
  assert.deepEqual(Array.from(seen!), new Array(32).fill(0)); // zeroed after use

  let seenOnThrow: Uint8Array | null = null;
  await assert.rejects(withRecoveryKeyBytes(key, async (bytes) => {
    seenOnThrow = bytes;
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(Array.from(seenOnThrow!), new Array(32).fill(0)); // zeroed on failure too

  for (const n of [31, 33, 0]) {
    let called = false;
    await assert.rejects(
      withRecoveryKeyBytes(toBase64Url(new Uint8Array(randomBytes(n))), async () => { called = true; }),
      /recovery key must be 32 bytes/,
    );
    assert.equal(called, false, `${n}-byte key must not reach the caller`);
  }
});

test('unlockWithRecoveryKey: only the exact 32-byte key unlocks', { timeout: 120_000 }, async () => {
  const vault = await import('../src/lib/vault-ext.ts');
  const { recoveryKey } = await vault.createVault(PASSPHRASE);
  vault.lockVault();
  const decoded = Buffer.from(recoveryKey, 'base64url');
  assert.equal(decoded.length, 32);
  const wrongLength = [
    toBase64Url(new Uint8Array(decoded.subarray(0, 31))),
    toBase64Url(new Uint8Array(Buffer.concat([decoded, Buffer.from([0])]))),
    '',
  ];
  for (const candidate of wrongLength) {
    assert.equal(await vault.unlockWithRecoveryKey(candidate), false);
    assert.equal(vault.isUnlocked(), false);
  }
  assert.equal(await vault.unlockWithRecoveryKey(toBase64Url(new Uint8Array(randomBytes(32)))), false);
  assert.equal(vault.isUnlocked(), false);
  assert.equal(await vault.unlockWithRecoveryKey(` ${recoveryKey} `), true);
  assert.equal(vault.isUnlocked(), true);
  await vault.wipeVault();
});
