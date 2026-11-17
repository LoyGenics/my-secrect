/**
 * Writes the fixture the Swift tests (and the DEBUG simulator seed) decrypt.
 *
 * Every byte comes from the REAL TypeScript crypto
 * (packages/crypto-adapters → libsodium-wrappers-sumo), with the same calls
 * apps/mobile/src/vault.ts makes in createVault() and upsertItem(), and the
 * same row-level tombstone deleteItem() writes. Test values only — never
 * put a real credential here.
 *
 * Run from the repo root:
 *   npx tsx native/ios-credential-provider/tests/generate-fixtures.ts [outPath]
 * Default outPath: tests/AutoFillCoreTests/Fixtures/autofill-fixture.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import {
  libsodiumAdapter as crypto,
  sodiumReady,
  toBase64,
  sha256,
} from '../../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../../packages/core/src/types';

const PASSPHRASE = 'autofill fixture passphrase (test only)';
const NOW = '2026-11-17T00:00:00.000Z';

// Same shapes as apps/mobile/src/vault.ts (StoredRow / StoredKeys).
interface StoredRow {
  id: string; revision: number; nonce: string; ciphertext: string;
  wrapped_item_key: string; wrapped_nonce: string; deleted_at: string | null;
}
interface StoredKeys {
  salt: string; wrapped_master: string; wrapped_master_nonce: string;
  wrapped_vault: string; wrapped_vault_nonce: string;
  wrapped_recovery: string; wrapped_recovery_nonce: string;
}

function item(id: string, type: VaultItem['type'], title: string, fields: Record<string, unknown>): VaultItem {
  return { id, type, schema_version: 1, title, fields, tags: [], relations: [], attachments: [], created_at: NOW, updated_at: NOW };
}

const ITEMS: VaultItem[] = [
  item('item_af_login_1', 'login', 'Example', {
    username: 'fixture-user@example.com', password: 'fixture-password-1', url: 'https://www.example.com/login',
  }),
  // Public demo credentials of a test-automation practice site; used by the
  // simulator end-to-end AutoFill check (README.md).
  item('item_af_login_2', 'login', 'The Internet (practice site)', {
    username: 'tomsmith', password: 'SuperSecretPassword!', url: 'https://the-internet.herokuapp.com/login',
  }),
  item('item_af_login_nopw', 'login', 'No password', { username: 'nopw-user', url: 'https://nopw.example.org' }),
  item('item_af_trashed', 'login', 'Trashed', {
    username: 'trashed-user', password: 'fixture-password-trashed', url: 'https://example.com',
  }),
  item('item_af_note', 'secure_note', 'Note', { body: 'not a login' }),
  item('item_af_passkey', 'passkey', 'Passkey', { credential_id: 'Y3JlZA', rp_id: 'example.com' }),
];
const TRASHED = new Set(['item_af_trashed']);

function hostOf(url: string): string {
  const h = new URL(url).hostname.toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

async function main(): Promise<void> {
  await sodiumReady;
  // createVault()
  const salt = crypto.randomBytes(16);
  const kek = await crypto.deriveKek(PASSPHRASE, salt);
  const master = crypto.randomBytes(32); const vk = crypto.randomBytes(32);
  const wMaster = await crypto.wrapKey(kek, master);
  const wVault = await crypto.wrapKey(master, vk);
  const recoveryKeyBytes = crypto.randomBytes(32);
  const recoveryKek = await sha256(recoveryKeyBytes);
  const wRecovery = await crypto.wrapKey(recoveryKek, master);
  const keys: StoredKeys = {
    salt: toBase64(salt), wrapped_master: toBase64(wMaster.wrapped), wrapped_master_nonce: toBase64(wMaster.nonce),
    wrapped_vault: toBase64(wVault.wrapped), wrapped_vault_nonce: toBase64(wVault.nonce),
    wrapped_recovery: toBase64(wRecovery.wrapped), wrapped_recovery_nonce: toBase64(wRecovery.nonce),
  };

  // upsertItem() for each item, then deleteItem()'s row-level tombstone.
  const rows: StoredRow[] = [];
  for (const it of ITEMS) {
    const stored: VaultItem = { ...it, favorite: it.favorite ?? false, deleted_at: null, updated_at: NOW, created_at: it.created_at || NOW };
    const itemKey = crypto.randomBytes(32);
    const wrapped = await crypto.wrapKey(vk, itemKey);
    const { nonce, ciphertext } = await crypto.encrypt(itemKey, Buffer.from(JSON.stringify(stored), 'utf8'));
    itemKey.fill(0);
    rows.push({
      id: stored.id, revision: 1, nonce: toBase64(nonce), ciphertext: toBase64(ciphertext),
      wrapped_item_key: toBase64(wrapped.wrapped), wrapped_nonce: toBase64(wrapped.nonce),
      deleted_at: TRASHED.has(stored.id) ? NOW : null,
    });
  }

  // autofill_index as specs/mobile-local-store.md §2 describes it: login and
  // passkey items only; titles, usernames and hosts — never secrets.
  const autofillIndex = ITEMS.filter((it) => it.type === 'login' || it.type === 'passkey').map((it) => ({
    id: it.id,
    title: it.title,
    username: String(it.type === 'login' ? it.fields.username : ''),
    host: hostOf(String(it.type === 'login' ? it.fields.url : `https://${String(it.fields.rp_id)}`)),
    type: it.type,
  }));

  const expected = ITEMS.filter((it) => it.type === 'login' && typeof it.fields.password === 'string' && !TRASHED.has(it.id))
    .map((it) => ({ id: it.id, username: it.fields.username, password: it.fields.password }));

  const fixture = {
    _comment: 'Generated by native/ios-credential-provider/tests/generate-fixtures.ts with packages/crypto-adapters (libsodium-wrappers-sumo), mirroring apps/mobile/src/vault.ts. Test values only. Regenerate instead of hand-editing.',
    passphrase: PASSPHRASE,
    account_master_key_b64: toBase64(master),
    stored_keys_json: JSON.stringify(keys),
    rows,
    autofill_index: autofillIndex,
    expected_logins: expected,
  };
  kek.fill(0); recoveryKek.fill(0); recoveryKeyBytes.fill(0); master.fill(0); vk.fill(0);

  const here = dirname(fileURLToPath(import.meta.url));
  const out = process.argv[2] ?? join(here, 'AutoFillCoreTests', 'Fixtures', 'autofill-fixture.json');
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
