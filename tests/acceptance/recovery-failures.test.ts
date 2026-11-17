/**
 * Acceptance K (recovery failure) + E (portability) at the module level.
 *
 * REAL production modules: apps/desktop/src/vault.ts (also the web app),
 * apps/extension/src/lib/vault-ext.ts, apps/mobile/src/vault.ts, with the
 * real libsodium adapter and the real backup parser. Only the host storage
 * object is in-memory (see lib/targets.ts). Each app has its OWN copy of the
 * restore code, so every failure kind is driven through all three.
 *
 * For every failure the test asserts the full "fail safely" contract:
 * the call rejects with the specific reason, host storage is byte-for-byte
 * unchanged (still empty on a fresh device), the vault stays locked and no
 * item is visible.
 *
 * Known defects are written as the CORRECT expectation and marked
 * `todo: 'DEFECT-…'` (they run and report, but do not fail the run). Set
 * ACCEPTANCE_STRICT=1 to make them hard failures.
 *
 * Run: npx tsx --test tests/acceptance/recovery-failures.test.ts
 */
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadTargets, type RestoreSecret, type VaultTarget } from './lib/targets.ts';
import { byId, comparable, danglingReferences, richItems, trashedItem } from './lib/vault-data.ts';
import type { VaultItem } from '../../packages/core/src/types';

const PASS = 'acceptance passphrase — K 42';
const OTHER_PASS = 'a different vault passphrase 7';
const defect = (id: string) => (process.env.ACCEPTANCE_STRICT ? undefined : id);

type Doc = {
  format: string; format_version: number; kdf: Record<string, unknown>;
  keys: Record<string, string>;
  items: Array<{ item_id: string; revision: number; encrypted_payload: string; encrypted_item_key: string; encryption_version: number }>;
};

let T: Record<VaultTarget['name'], VaultTarget>;
const backups: Partial<Record<VaultTarget['name'], { json: string; recoveryKey: string; items: VaultItem[] }>> = {};
let foreign: { json: string; recoveryKey: string };

const flip = (b64: string, at: 'last' | 'first' | number = 'last') => {
  const b = Buffer.from(b64, 'base64');
  const i = at === 'last' ? b.length - 1 : at === 'first' ? 0 : at;
  b[i] ^= 0x01;
  return b.toString('base64');
};
const clone = (d: Doc): Doc => structuredClone(d);

before(async () => {
  T = await loadTargets();
  // Each app builds a vault with the full relation-rich data set, trashes one item, exports.
  for (const t of Object.values(T)) {
    const { recoveryKey } = await t.create(PASS);
    if (!t.isUnlocked()) assert.equal(await t.unlock(PASS), true);
    for (const it of richItems(t.name.toUpperCase())) await t.upsert(it);
    await t.upsert(trashedItem(t.name.toUpperCase()));
    await t.trash(trashedItem().id);
    const json = await t.exportBackup();
    backups[t.name] = { json, recoveryKey, items: t.items().filter((i) => !i.deleted_at) };
    t.lock();
    await t.wipe();
  }
  // A second, unrelated vault: its backup and its (valid) recovery key are "wrong credentials".
  const { recoveryKey } = await T.desktop.create(OTHER_PASS);
  if (!T.desktop.isUnlocked()) await T.desktop.unlock(OTHER_PASS);
  await T.desktop.upsert(richItems('FOREIGN')[0]);
  foreign = { json: await T.desktop.exportBackup(), recoveryKey };
  T.desktop.lock();
  await T.desktop.wipe();
});

async function expectSafeFailure(t: VaultTarget, json: string, secret: RestoreSecret, re: RegExp) {
  const before = t.snapshot();
  await assert.rejects(() => t.restore(json, secret), (err: Error) => {
    assert.match(err.message, re, `${t.name}: unexpected error "${err.message}"`);
    return true;
  });
  assert.equal(t.snapshot(), before, `${t.name}: host storage changed after a failed restore`);
  assert.equal(t.isUnlocked(), false, `${t.name}: vault unlocked after a failed restore`);
  assert.deepEqual(t.items(), [], `${t.name}: items visible after a failed restore`);
}

const targets = ['desktop', 'extension', 'mobile'] as const;

describe('E: a backup from any app restores on a fresh device of any app, every item + relation intact', () => {
  for (const from of targets) {
    for (const to of targets) {
      test(`${from} backup -> fresh ${to}`, async () => {
        const src = backups[from]!;
        const t = T[to];
        assert.equal(t.snapshot(), '[]', 'target starts with empty storage (fresh device)');
        await t.restore(src.json, { passphrase: PASS });
        const got = byId(t.items());
        assert.deepEqual(got.map(comparable), byId(src.items).map(comparable), 'every live item identical (fields, tags, relations, favorites, attachments, timestamps)');
        assert.deepEqual(danglingReferences(got), [], 'every relation target and folder parent restored');
        assert.equal(got.some((i) => i.title.includes('(trashed)')), false, 'trash is not part of a portable backup (vault.ts exportEncrypted: "Trash rows are excluded")');
        t.lock();
        assert.equal(await t.unlockRecovery(src.recoveryKey), true, 'original recovery key still opens the restored vault');
        assert.equal(t.items().length, src.items.length);
        t.lock();
        assert.equal(await t.unlock(PASS), true, 'original passphrase opens the restored vault');
        t.lock();
        await t.wipe();
      });
    }
  }
});

describe('K1: wrong recovery credentials fail safely (all three restore implementations)', () => {
  for (const name of targets) {
    test(`${name}: wrong passphrase / empty passphrase / another vault's recovery key / malformed key / both secrets`, async () => {
      const t = T[name];
      const { json } = backups.desktop!;
      await expectSafeFailure(t, json, { passphrase: 'not the passphrase' }, /could not open the backup with this passphrase/);
      await expectSafeFailure(t, json, { passphrase: '' }, /passphrase must not be empty/);
      await expectSafeFailure(t, json, { recoveryKey: foreign.recoveryKey }, /could not open the backup with this recovery key/);
      await expectSafeFailure(t, json, { recoveryKey: randomBytes(32).toString('base64url') }, /could not open the backup with this recovery key/);
      await expectSafeFailure(t, json, { recoveryKey: 'too-short' }, /recovery key must be 32 bytes/);
      await expectSafeFailure(t, json, { recoveryKey: PASS }, /recovery key must be 32 bytes/);
      await expectSafeFailure(t, json, { recoveryKey: randomBytes(31).toString('base64url') }, /recovery key must be 32 bytes/);
      await expectSafeFailure(t, json, { passphrase: PASS, recoveryKey: foreign.recoveryKey } as never, /not both/);
      // Right secret, wrong backup: another vault's file with this vault's passphrase.
      await expectSafeFailure(t, foreign.json, { passphrase: PASS }, /could not open the backup with this passphrase/);
      await expectSafeFailure(t, foreign.json, { recoveryKey: backups.desktop!.recoveryKey }, /could not open the backup with this recovery key/);
    });
  }

  test('after a restore, wrong unlock credentials leave the vault locked and storage untouched', async () => {
    for (const name of targets) {
      const t = T[name];
      await t.restore(backups[name]!.json, { passphrase: PASS });
      t.lock();
      const snap = t.snapshot();
      assert.equal(await t.unlock('wrong passphrase'), false, `${name}`);
      assert.equal(await t.unlockRecovery(foreign.recoveryKey), false, `${name}`);
      assert.equal(await t.unlockRecovery(randomBytes(32).toString('base64url')), false, `${name}`);
      assert.equal(t.isUnlocked(), false);
      assert.equal(t.snapshot(), snap, `${name}: failed unlock must not write`);
      await t.wipe();
    }
  });
});

describe('K2: corrupted backup fails safely', () => {
  for (const name of targets) {
    test(`${name}: truncated / not JSON / wrong version / missing envelope / corrupted key envelope / weakened KDF / bad base64 / duplicate ids`, async () => {
      const t = T[name];
      const { json, recoveryKey } = backups.desktop!;
      const doc = JSON.parse(json) as Doc;
      const pass = { passphrase: PASS };
      for (const text of ['', '{', json.slice(0, json.length >> 1), json.slice(0, -1)]) {
        await expectSafeFailure(t, text, pass, /not valid JSON/);
      }
      await expectSafeFailure(t, JSON.stringify({ ...doc, format_version: 1 }), pass, /format_version 1/);
      await expectSafeFailure(t, JSON.stringify({ ...doc, format_version: 4 }), pass, /unsupported format_version|newer/i);
      await expectSafeFailure(t, JSON.stringify({ ...doc, format: 'something-else' }), pass, /format/);
      const { keys: _k, ...noKeys } = doc;
      await expectSafeFailure(t, JSON.stringify(noKeys), pass, /wrapped key envelope/);
      await expectSafeFailure(t, JSON.stringify({ ...doc, items: 'nope' }), pass, /items/);
      await expectSafeFailure(t, JSON.stringify({ ...doc, kdf: { ...doc.kdf, opslimit: 1 } }), pass, /kdf\.opslimit/);
      await expectSafeFailure(t, JSON.stringify({ ...doc, kdf: { ...doc.kdf, memlimit: 1024 } }), pass, /kdf\.memlimit/);
      const dup = clone(doc); dup.items.push(structuredClone(dup.items[0]));
      await expectSafeFailure(t, JSON.stringify(dup), pass, /duplicate "item_id"/);
      const badB64 = clone(doc); badB64.items[0].encrypted_payload = '***not base64***';
      await expectSafeFailure(t, JSON.stringify(badB64), pass, /not valid base64/);
      const shortBlob = clone(doc); shortBlob.items[0].encrypted_payload = Buffer.alloc(10).toString('base64');
      await expectSafeFailure(t, JSON.stringify(shortBlob), pass, /not valid base64 of an encrypted blob/);
      // Key envelope corruption: each wrapped key, the salt, and a nonce.
      const c1 = clone(doc); c1.keys.wrapped_master = flip(c1.keys.wrapped_master);
      await expectSafeFailure(t, JSON.stringify(c1), pass, /could not open the backup with this passphrase/);
      const c2 = clone(doc); c2.keys.salt = flip(c2.keys.salt, 'first');
      await expectSafeFailure(t, JSON.stringify(c2), pass, /could not open the backup with this passphrase/);
      const c3 = clone(doc); c3.keys.wrapped_vault = flip(c3.keys.wrapped_vault);
      await expectSafeFailure(t, JSON.stringify(c3), pass, /could not unwrap the vault key/);
      await expectSafeFailure(t, JSON.stringify(c3), { recoveryKey }, /could not unwrap the vault key/);
      const c4 = clone(doc); c4.keys.wrapped_recovery = flip(c4.keys.wrapped_recovery);
      await expectSafeFailure(t, JSON.stringify(c4), { recoveryKey }, /could not open the backup with this recovery key/);
      const c5 = clone(doc); c5.keys.wrapped_master_nonce = Buffer.from(c5.keys.wrapped_master_nonce, 'base64').subarray(0, 12).toString('base64');
      await expectSafeFailure(t, JSON.stringify(c5), pass, /could not open the backup with this passphrase|nonce/);
    });

    // Fixed by the authenticated item index (backup format_version 3); the
    // apps not integrated yet keep the todo.
    const omissionTodo = name !== 'mobile' ? undefined : defect('DEFECT-K2-omission: backup has no authenticated item list; a dropped item restores "successfully" as N-1 items');
    test(`${name}: a backup with one item silently removed is detected`, { todo: omissionTodo }, async () => {
      const t = T[name];
      const doc = JSON.parse(backups.desktop!.json) as Doc;
      const dropped = clone(doc); dropped.items.splice(3, 1);
      try {
        await expectSafeFailure(t, JSON.stringify(dropped), { passphrase: PASS }, /item list does not match its authenticated index/);
      } finally {
        t.lock();
        await t.wipe(); // if a regression lets it restore, leave a fresh device for the next test
      }
    });
  }

  test('corrupted wrapped_recovery is undetectable during a passphrase restore, and the recovery key then fails safely later', async () => {
    // Not a defect: the recovery wrap can only be checked with the recovery key.
    // Documented so nobody claims a passphrase restore "verified the whole backup".
    for (const name of targets) {
      const t = T[name];
      const doc = JSON.parse(backups.desktop!.json) as Doc;
      doc.keys.wrapped_recovery = flip(doc.keys.wrapped_recovery);
      await t.restore(JSON.stringify(doc), { passphrase: PASS });
      t.lock();
      const snap = t.snapshot();
      assert.equal(await t.unlockRecovery(backups.desktop!.recoveryKey), false, `${name}: corrupted recovery wrap must not unlock`);
      assert.equal(t.snapshot(), snap);
      assert.equal(await t.unlock(PASS), true, `${name}: passphrase still works`);
      t.lock();
      await t.wipe();
    }
  });
});

describe('K3: tampered ciphertext fails safely', () => {
  for (const name of targets) {
    test(`${name}: flipped payload byte / flipped item-key byte / swapped payloads / swapped item keys / foreign-vault row / id relabel`, async () => {
      const t = T[name];
      const doc = JSON.parse(backups.desktop!.json) as Doc;
      const foreignDoc = JSON.parse(foreign.json) as Doc;
      const secrets: RestoreSecret[] = [{ passphrase: PASS }, { recoveryKey: backups.desktop!.recoveryKey }];
      for (const secret of secrets) {
        for (const at of ['last', 'first', 40] as const) {
          const a = clone(doc); a.items[2].encrypted_payload = flip(a.items[2].encrypted_payload, at);
          await expectSafeFailure(t, JSON.stringify(a), secret, /could not decrypt item/);
          const b = clone(doc); b.items[5].encrypted_item_key = flip(b.items[5].encrypted_item_key, at);
          await expectSafeFailure(t, JSON.stringify(b), secret, /could not decrypt item/);
        }
        // Both rows stay authentic, but each payload now sits under the other's id+key: key mismatch.
        const swapped = clone(doc);
        [swapped.items[0].encrypted_payload, swapped.items[1].encrypted_payload] = [swapped.items[1].encrypted_payload, swapped.items[0].encrypted_payload];
        await expectSafeFailure(t, JSON.stringify(swapped), secret, /could not decrypt item/);
        // Whole row (payload + its own key) moved under another id: authentic ciphertext, wrong binding.
        const relabel = clone(doc);
        [relabel.items[0].item_id, relabel.items[1].item_id] = [relabel.items[1].item_id, relabel.items[0].item_id];
        await expectSafeFailure(t, JSON.stringify(relabel), secret, /does not match item_id/);
        // A row from another vault spliced in (valid ciphertext under a different vault key).
        const spliced = clone(doc);
        spliced.items.push({ ...foreignDoc.items[0], item_id: 'item_spliced_from_another_vault' });
        await expectSafeFailure(t, JSON.stringify(spliced), secret, /could not decrypt item/);
      }
    });
  }

  test('desktop: tampering is also rejected by importEncrypted into an unlocked vault, with no partial merge', async () => {
    const t = T.desktop;
    const d = await import('../../apps/desktop/src/vault.ts');
    await t.restore(backups.desktop!.json, { passphrase: PASS });
    const snap = t.snapshot();
    const before = byId(t.items()).map(comparable);
    const doc = JSON.parse(backups.desktop!.json) as Doc;
    for (const row of doc.items) row.revision += 10; // newer revisions: would be merged if they decrypted
    doc.items[doc.items.length - 1].encrypted_payload = flip(doc.items[doc.items.length - 1].encrypted_payload);
    await assert.rejects(() => d.importEncrypted(JSON.stringify(doc)), /could not decrypt item/);
    assert.equal(t.snapshot(), snap, 'no partial merge');
    assert.deepEqual(byId(t.items()).map(comparable), before);
    t.lock();
    await t.wipe();
  });
});
