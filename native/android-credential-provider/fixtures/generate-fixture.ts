/**
 * Generates the Android provider test fixture with the REAL TypeScript
 * crypto (packages/crypto-adapters, libsodium), calling it exactly as
 * apps/mobile/src/vault.ts does in createVault() and upsertItem():
 *
 *   salt 16B -> Argon2id KEK -> wrap AMK; AMK -> wrap Vault Key;
 *   per item: random Item Key wrapped by the Vault Key, VaultItem JSON
 *   (UTF-8) encrypted with the Item Key. Every blob is standard base64,
 *   nonces (24B) stored separately, exactly like StoredKeys / StoredRow.
 *
 * The output holds TEST keys and TEST passwords only. It is written to a
 * gitignored location (the generated Android project's androidTest
 * assets) and is never committed: fresh random keys on every run.
 *
 * Run from the repo root (after `npx expo prebuild --platform android`):
 *   npx tsx native/android-credential-provider/fixtures/generate-fixture.ts [outDir]
 * Default outDir: apps/mobile/android/app/src/androidTest/assets
 * Also copies tests/crypto-vectors/argon2id-vectors.json next to it so the
 * instrumented tests check the shared vectors.
 */
import { Buffer } from 'node:buffer';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  libsodiumAdapter as crypto,
  sha256,
  sodiumReady,
  toBase64,
} from '../../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../../packages/core/src/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'apps/mobile/android/app/src/androidTest/assets'));

// Same shapes as apps/mobile/src/vault.ts.
interface StoredRow {
  id: string; revision: number; nonce: string; ciphertext: string;
  wrapped_item_key: string; wrapped_nonce: string; deleted_at?: string | null;
}
interface StoredKeys {
  salt: string; wrapped_master: string; wrapped_master_nonce: string;
  wrapped_vault: string; wrapped_vault_nonce: string;
  wrapped_recovery: string; wrapped_recovery_nonce: string;
}

function item(id: string, type: VaultItem['type'], title: string, fields: Record<string, unknown>): VaultItem {
  const now = new Date().toISOString();
  return { id, type, schema_version: 1, title, fields, tags: [], relations: [], attachments: [], favorite: false, deleted_at: null, created_at: now, updated_at: now };
}

// upsertItem() from apps/mobile/src/vault.ts, minus storage.
async function encryptRow(vaultKey: Uint8Array, stored: VaultItem): Promise<StoredRow> {
  const itemKey = crypto.randomBytes(32);
  const wrapped = await crypto.wrapKey(vaultKey, itemKey);
  const { nonce, ciphertext } = await crypto.encrypt(itemKey, Buffer.from(JSON.stringify(stored), 'utf8'));
  itemKey.fill(0);
  return { id: stored.id, revision: 1, nonce: toBase64(nonce), ciphertext: toBase64(ciphertext), wrapped_item_key: toBase64(wrapped.wrapped), wrapped_nonce: toBase64(wrapped.nonce), deleted_at: null };
}

async function main(): Promise<void> {
  await sodiumReady;
  // createVault() from apps/mobile/src/vault.ts.
  const passphrase = 'fixture passphrase (test only)';
  const salt = crypto.randomBytes(16);
  const kek = await crypto.deriveKek(passphrase, salt);
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

  const items: VaultItem[] = [
    item('item_login_example', 'login', 'Example', { username: 'alice@example.com', password: 'Tëst-pässwörd ✓ 🔑 #1', url: 'https://example.com/login' }),
    item('item_login_other', 'login', 'Other site', { username: 'bob', password: 'other-site-test-password', url: 'https://accounts.example.org/' }),
    item('item_login_nopass', 'login', 'No password', { username: 'carol@example.com', url: 'https://example.com/' }),
    item('item_note', 'secure_note', 'A note', { body: 'not a credential' }),
    item('item_login_trashed', 'login', 'Trashed', { username: 'dave@example.com', password: 'trashed-test-password', url: 'https://example.com/' }),
  ];
  const rows: StoredRow[] = [];
  for (const it of items) rows.push(await encryptRow(vk, it));
  // deleteItem() marks the row; the payload stays encrypted as-is.
  rows.find((r) => r.id === 'item_login_trashed')!.deleted_at = new Date().toISOString();

  const autofillIndex = [
    { id: 'item_login_example', title: 'Example', username: 'alice@example.com', host: 'example.com', type: 'login' },
    { id: 'item_login_other', title: 'Other site', username: 'bob', host: 'accounts.example.org', type: 'login' },
    { id: 'item_login_nopass', title: 'No password', username: 'carol@example.com', host: 'example.com', type: 'login' },
  ];

  const fixture = {
    format: 'my-secrect-android-provider-fixture-v1',
    note: 'TEST VALUES ONLY. Generated by native/android-credential-provider/fixtures/generate-fixture.ts with packages/crypto-adapters.',
    amk_b64: toBase64(master),
    stored_keys_json: JSON.stringify(keys),
    rows,
    autofill_index: autofillIndex,
    expected: {
      item_login_example: { username: 'alice@example.com', password: 'Tëst-pässwörd ✓ 🔑 #1' },
      item_login_other: { username: 'bob', password: 'other-site-test-password' },
    },
  };
  kek.fill(0); master.fill(0); vk.fill(0); recoveryKek.fill(0); recoveryKeyBytes.fill(0);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'vault-fixture.json'), JSON.stringify(fixture, null, 2));
  copyFileSync(path.join(repoRoot, 'tests/crypto-vectors/argon2id-vectors.json'), path.join(outDir, 'argon2id-vectors.json'));
  console.log(`wrote ${path.join(outDir, 'vault-fixture.json')} (${rows.length} rows) and argon2id-vectors.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
