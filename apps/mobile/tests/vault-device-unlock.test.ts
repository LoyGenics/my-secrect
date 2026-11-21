/**
 * Real src/vault.ts on a real SQLite store (sql.js). DeviceKey is the
 * software stand-in from support/softwareDeviceKey.ts: these tests prove
 * how vault.ts reacts to each DeviceKey outcome (and the AsyncStorage
 * migration path through hasVault/unlock), not the Swift/Kotlin code.
 * Run: npx tsx --test apps/mobile/tests/vault-device-unlock.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBase64 } from '../../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../../packages/core/src/types';
import * as vault from '../src/vault';
import { LEGACY_KEYS_KEY, LEGACY_ROWS_KEY } from '../src/storage/migration';
import type { VaultStore } from '../src/storage/vaultStore';
import { MemoryKeyValue, openTestStore, type TestDb } from './support/sqljs';
import { SOFTWARE_SCHEME, SoftwareDeviceKey } from './support/softwareDeviceKey';

const PASS = 'correct-horse-battery-staple';
const login: VaultItem = {
  id: 'item_login_01', type: 'login', schema_version: 1, title: 'Bank login',
  fields: { username: 'ada@example.test', password: 'pw-DO-NOT-LEAK', url: 'https://www.bank.example.test/login', totp_secret: 'JBSWY3DPEHPK3PXP' },
  tags: [], relations: [], attachments: [], favorite: false, created_at: '2026-11-17T00:00:00.000Z', updated_at: '2026-11-17T00:00:00.000Z',
};
const note: VaultItem = { ...login, id: 'item_note_01', type: 'secure_note', title: 'Note', fields: { body: 'note-DO-NOT-LEAK' } };

async function setup(legacy = new MemoryKeyValue()): Promise<TestDb & { store: VaultStore; dk: SoftwareDeviceKey; legacy: MemoryKeyValue }> {
  const t = await openTestStore();
  const dk = new SoftwareDeviceKey();
  vault.setVaultPlatform({ openStore: async () => t.store, legacy, deviceKey: dk });
  return { ...t, dk, legacy };
}
const bytesContain = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(Buffer.from(needle, 'utf8'));

test('enrol after passphrase unlock, then biometric unlock really opens the vault', { timeout: 120_000 }, async () => {
  const { store, dk, db } = await setup();
  await vault.createVault(PASS);
  await vault.upsertItem(login);
  await vault.upsertItem(note);
  await assert.rejects(() => vault.enableDeviceUnlock('p'), /right after a passphrase/); // created, not unlocked
  vault.lockVault();
  assert.equal(await vault.unlockVault(PASS), true);
  assert.deepEqual(await vault.enableDeviceUnlock('Turn on'), { ok: true });

  const row = await store.getDeviceUnlock();
  assert.equal(row?.scheme, SOFTWARE_SCHEME);
  assert.ok(row && row.wrapped_amk.length > 0);
  const state = await vault.getDeviceUnlockState();
  assert.equal(state.enrolled, true);

  // Nothing secret in the database file, not even with the (test) store unencrypted.
  const file = db.export();
  for (const s of ['pw-DO-NOT-LEAK', 'note-DO-NOT-LEAK', 'JBSWY3DPEHPK3PXP']) assert.equal(bytesContain(file, s), false, s);
  assert.deepEqual(await store.listAutofillIndex(), [{ id: login.id, title: 'Bank login', username: 'ada@example.test', host: 'bank.example.test', type: 'login' }]);

  vault.lockVault();
  assert.equal(vault.isUnlocked(), false);
  assert.deepEqual(await vault.unlockWithDeviceKey('Unlock my-secrect'), { ok: true });
  assert.equal(vault.listItems().find((i) => i.id === login.id)?.fields.password, 'pw-DO-NOT-LEAK');
  assert.deepEqual(dk.prompts, ['Turn on', 'Unlock my-secrect']);
  // A biometric session cannot enrol again.
  await assert.rejects(() => vault.enableDeviceUnlock('again'), /right after a passphrase/);
});

test('cancel / no match / lockout keep the vault locked and the enrolment', { timeout: 120_000 }, async () => {
  const { store, dk } = await setup();
  await vault.createVault(PASS);
  vault.lockVault();
  await vault.unlockVault(PASS);
  await vault.enableDeviceUnlock('p');
  vault.lockVault();
  for (const code of ['USER_CANCEL', 'AUTH_FAILED', 'LOCKOUT', 'NOT_ENROLLED', 'NOT_AVAILABLE'] as const) {
    dk.nextError = code;
    assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code });
    assert.equal(vault.isUnlocked(), false, code);
    assert.ok(await store.getDeviceUnlock(), code);
  }
  assert.equal(dk.removeCalls, 0);
});

test('biometric re-enrolment: KEY_INVALIDATED deletes row + key, passphrase still works, re-enable works', { timeout: 120_000 }, async () => {
  const { store, dk } = await setup();
  await vault.createVault(PASS);
  await vault.upsertItem(login);
  vault.lockVault();
  await vault.unlockVault(PASS);
  await vault.enableDeviceUnlock('p');
  vault.lockVault();
  dk.invalidated = true;
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code: 'KEY_INVALIDATED' });
  assert.equal(vault.isUnlocked(), false);
  assert.equal(await store.getDeviceUnlock(), null);
  assert.equal(dk.removeCalls, 1);
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code: 'NOT_SET_UP' });
  assert.equal(await vault.unlockVault(PASS), true);
  assert.deepEqual(await vault.enableDeviceUnlock('p'), { ok: true });
  vault.lockVault();
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: true });
});

test('a released key that is not this vault\'s Master Key never unlocks (CORRUPT, enrolment dropped)', { timeout: 120_000 }, async () => {
  const { store, dk } = await setup();
  await vault.createVault(PASS);
  vault.lockVault();
  await vault.unlockVault(PASS);
  await vault.enableDeviceUnlock('p');
  vault.lockVault();
  dk.forceAmkB64 = toBase64(new Uint8Array(32).fill(7));
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code: 'CORRUPT' });
  assert.equal(vault.isUnlocked(), false);
  assert.equal(await store.getDeviceUnlock(), null);

  dk.forceAmkB64 = null;
  await vault.unlockVault(PASS);
  await vault.enableDeviceUnlock('p');
  vault.lockVault();
  dk.forceAmkB64 = 'c2hvcnQ='; // 5 bytes
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code: 'CORRUPT' });
  assert.equal(vault.isUnlocked(), false);
});

test('enrolment refused or cancelled writes no row; Settings path needs the right passphrase', { timeout: 120_000 }, async () => {
  const { store, dk } = await setup();
  await vault.createVault(PASS);
  dk.nextError = 'USER_CANCEL';
  assert.deepEqual(await vault.enableDeviceUnlockWithPassphrase(PASS, 'p'), { ok: false, code: 'USER_CANCEL' });
  assert.equal(await store.getDeviceUnlock(), null);
  assert.deepEqual(await vault.enableDeviceUnlockWithPassphrase('wrong passphrase', 'p'), { ok: false, code: 'WRONG_PASSPHRASE' });
  assert.equal(await store.getDeviceUnlock(), null);
  assert.deepEqual(await vault.enableDeviceUnlockWithPassphrase(PASS, 'p'), { ok: true });
  assert.ok(await store.getDeviceUnlock());
});

test('disable, passphrase change and wipe each delete the row and the key', { timeout: 180_000 }, async () => {
  const { store, dk } = await setup();
  await vault.createVault(PASS);
  await vault.enableDeviceUnlockWithPassphrase(PASS, 'p');
  await vault.disableDeviceUnlock();
  assert.equal(await store.getDeviceUnlock(), null);
  assert.equal(dk.removeCalls, 1);

  await vault.enableDeviceUnlockWithPassphrase(PASS, 'p');
  await vault.upsertItem(login);
  assert.equal((await store.listAutofillIndex()).length, 1);
  await vault.changePassphrase(PASS, 'a-brand-new-passphrase');
  assert.equal(await store.getDeviceUnlock(), null);
  assert.deepEqual(await store.listAutofillIndex(), []);
  assert.equal(dk.removeCalls, 2);
  vault.lockVault();
  assert.equal(await vault.unlockVault('a-brand-new-passphrase'), true);

  await vault.enableDeviceUnlock('p');
  await vault.upsertItem(login);
  await vault.wipeVault();
  assert.equal(dk.removeCalls, 3);
  assert.equal(await store.isOccupied(), false);
  assert.equal(await store.getDeviceUnlock(), null);
  assert.deepEqual(await store.listAutofillIndex(), []);
  assert.equal(vault.isUnlocked(), false);
  assert.equal(await vault.hasVault(), false);
});

test('sign-out locks and leaves nothing for biometric unlock or the credential providers; the passphrase still opens the vault', { timeout: 120_000 }, async () => {
  const { store, dk } = await setup();
  await vault.createVault(PASS);
  await vault.upsertItem(login);
  vault.lockVault();
  await vault.unlockVault(PASS);
  await vault.enableDeviceUnlock('p');
  assert.equal((await store.listAutofillIndex()).length, 1);

  await vault.signOutVault();
  assert.equal(vault.isUnlocked(), false);
  assert.equal(await store.getDeviceUnlock(), null);
  assert.deepEqual(await store.listAutofillIndex(), []);
  assert.equal(dk.removeCalls, 1);
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code: 'NOT_SET_UP' });

  assert.equal(await vault.hasVault(), true);
  assert.equal(await vault.unlockVault(PASS), true);
  assert.equal(vault.listItems().find((i) => i.id === login.id)?.fields.password, 'pw-DO-NOT-LEAK');
  assert.deepEqual(await store.listAutofillIndex(), []);
});

test('autofill index exists only while biometric unlock is on, and follows item writes', { timeout: 120_000 }, async () => {
  const { store } = await setup();
  await vault.createVault(PASS);
  await vault.upsertItem(login);
  assert.deepEqual(await store.listAutofillIndex(), []); // biometric unlock off: no index
  await vault.enableDeviceUnlockWithPassphrase(PASS, 'p');
  assert.deepEqual((await store.listAutofillIndex()).map((e) => e.id), [login.id]); // enrolment fills it
  await vault.permanentlyDeleteItem(login.id);
  await vault.upsertItem(login);
  assert.equal((await store.listAutofillIndex()).length, 1);
  await vault.deleteItem(login.id);
  assert.deepEqual(await store.listAutofillIndex(), []);
  await vault.restoreItem(login.id);
  assert.equal((await store.listAutofillIndex())[0]?.id, login.id);
  await vault.permanentlyDeleteItem(login.id);
  assert.deepEqual(await store.listAutofillIndex(), []);
  assert.equal(await store.countRows(), 0);
  await vault.upsertItem(login);
  assert.equal((await store.listAutofillIndex()).length, 1);
  await vault.disableDeviceUnlock();
  assert.deepEqual(await store.listAutofillIndex(), []); // turning it off clears the index
  await vault.upsertItem({ ...login, title: 'renamed' });
  vault.lockVault();
  await vault.unlockVault(PASS);
  assert.deepEqual(await store.listAutofillIndex(), []); // and unlock does not refill it
});

test('AsyncStorage vault from the old build migrates on first open and unlocks with its passphrase', { timeout: 180_000 }, async () => {
  // Build an old-format vault: same crypto, then serialise exactly as the
  // AsyncStorage build stored it (StoredKeys JSON + StoredRow[] JSON).
  const old = await setup();
  await vault.createVault(PASS);
  await vault.upsertItem(login);
  await vault.upsertItem(note);
  await vault.deleteItem(note.id);
  const legacy = new MemoryKeyValue();
  legacy.map.set(LEGACY_KEYS_KEY, (await old.store.getKeysJson())!);
  legacy.map.set(LEGACY_ROWS_KEY, JSON.stringify(await old.store.listRows()));
  legacy.map.set('my-secrect.api-base-url', '');

  const fresh = await setup(legacy);
  assert.equal(await vault.hasVault(), true);
  assert.equal(vault.getStorageError(), null);
  assert.deepEqual([...legacy.map.keys()], ['my-secrect.api-base-url']);
  assert.equal(await fresh.store.countRows(), 2);
  assert.equal(await vault.unlockVault(PASS), true);
  assert.equal(vault.listItems().find((i) => i.id === login.id)?.fields.password, 'pw-DO-NOT-LEAK');
  assert.deepEqual(vault.listTrash().map((i) => i.id), [note.id]);
  assert.deepEqual(await fresh.store.listAutofillIndex(), []); // biometric unlock not on yet
});

test('failed migration: lock screen gets the error, nothing unlocks, AsyncStorage untouched', { timeout: 60_000 }, async () => {
  const legacy = new MemoryKeyValue();
  legacy.map.set(LEGACY_KEYS_KEY, '{"salt":"x"}');
  legacy.map.set(LEGACY_ROWS_KEY, '[]');
  const t = await setup(legacy);
  assert.equal(await vault.hasVault(), true);
  assert.match(vault.getStorageError() ?? '', /missing fields/);
  assert.equal(await vault.unlockVault(PASS), false);
  assert.deepEqual(await vault.unlockWithDeviceKey('p'), { ok: false, code: 'STORAGE' });
  assert.equal(legacy.map.size, 2);
  assert.equal(await t.store.isOccupied(), false);
});
