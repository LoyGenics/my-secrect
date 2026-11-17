/**
 * Extension vault — mirrors apps/desktop/src/vault.ts exactly in crypto,
 * but stores in chrome.storage.local instead of localStorage.
 *
 * Key hierarchy (all keys 32 bytes, XChaCha20-Poly1305 via libsodium):
 *   passphrase --Argon2id (salt 16B)--> KEK
 *   KEK --wrap--> Account Master Key (random 32B)
 *   Account Master Key --wrap--> Vault Key (random 32B)
 *   Vault Key --wrap--> per-item Item Key (random 32B, fresh per write)
 *   Item Key --encrypt--> VaultItem JSON (fresh 24B nonce)
 * Recovery: SHA-256(recovery key bytes) wraps the Master Key; shown once.
 *
 * IMPORTANT — separate vault: the extension runs under the chrome-extension://
 * origin, so its chrome.storage.local is NOT the desktop app's localStorage
 * and NOT the web client's storage. This extension vault is a standalone
 * local vault until Phase 2 sync unifies devices. Do not present it as
 * synced with the desktop app.
 *
 * Only the background service worker imports this file. The popup and the
 * options page NEVER import it and never hold keys — they talk to the
 * background through chrome.runtime messages (see lib/messages.ts).
 * Keys live in the worker's memory only and are zero-filled on lock. MV3
 * workers can be terminated by Chrome at any time; when that happens the
 * in-memory session is gone and the user must unlock again — that is
 * correct behaviour, not a bug.
 */
import {
  libsodiumAdapter as crypto,
  sodiumReady,
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  sha256,
} from '../../../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../../../packages/core/src/types';

const ROWS_KEY = 'my-secrect.ext.vault.rows.v1';
const KEYS_KEY = 'my-secrect.ext.vault.keys.v1';

interface StoredRow {
  id: string;
  revision: number;
  nonce: string;
  ciphertext: string;
  wrapped_item_key: string;
  wrapped_nonce: string;
  deleted_at?: string | null;
}

interface StoredKeys {
  salt: string;
  wrapped_master: string;
  wrapped_master_nonce: string;
  wrapped_vault: string;
  wrapped_vault_nonce: string;
  wrapped_recovery: string;
  wrapped_recovery_nonce: string;
}

export interface VaultExport {
  format: 'my-secrect-vault-export';
  format_version: 1;
  exported_at: string;
  vault_id: 'extension-local';
  items: Array<{
    item_id: string;
    revision: number;
    encrypted_payload: string;
    encrypted_item_key: string;
    encryption_version: number;
  }>;
  relations_included: true;
}

let masterKey: Uint8Array | null = null;
let vaultKey: Uint8Array | null = null;
let unlockedItems: VaultItem[] = [];

async function loadRows(): Promise<StoredRow[]> {
  const stored = await chrome.storage.local.get(ROWS_KEY);
  const rows = stored[ROWS_KEY] as StoredRow[] | undefined;
  return Array.isArray(rows) ? rows : [];
}

async function saveRows(rows: StoredRow[]): Promise<void> {
  await chrome.storage.local.set({ [ROWS_KEY]: rows });
}

async function loadKeys(): Promise<StoredKeys | null> {
  const stored = await chrome.storage.local.get(KEYS_KEY);
  const keys = stored[KEYS_KEY] as StoredKeys | undefined;
  return keys && typeof keys === 'object' ? keys : null;
}

function clearMemory(): void {
  masterKey?.fill(0);
  vaultKey?.fill(0);
  masterKey = null;
  vaultKey = null;
  unlockedItems = [];
}

export function isUnlocked(): boolean {
  return vaultKey !== null;
}

export async function hasVault(): Promise<boolean> {
  return (await loadKeys()) !== null;
}

export function listUnlockedItems(): VaultItem[] {
  return [...unlockedItems];
}

async function decryptRows(rows: StoredRow[]): Promise<VaultItem[]> {
  if (!vaultKey) throw new Error('vault locked');
  const items: VaultItem[] = [];
  for (const row of rows) {
    const itemKey = await crypto.unwrapKey(
      vaultKey,
      fromBase64(row.wrapped_nonce),
      fromBase64(row.wrapped_item_key),
    );
    const plaintext = await crypto.decrypt(
      itemKey,
      fromBase64(row.nonce),
      fromBase64(row.ciphertext),
    );
    const item = JSON.parse(new TextDecoder().decode(plaintext)) as VaultItem;
    if (row.deleted_at) item.deleted_at = row.deleted_at;
    items.push(item);
    itemKey.fill(0);
  }
  return items;
}

async function finishUnlock(master: Uint8Array, keys: StoredKeys): Promise<boolean> {
  try {
    masterKey = master;
    vaultKey = await crypto.unwrapKey(
      master,
      fromBase64(keys.wrapped_vault_nonce),
      fromBase64(keys.wrapped_vault),
    );
    unlockedItems = await decryptRows(await loadRows());
    return true;
  } catch {
    clearMemory();
    return false;
  }
}

export async function createVault(passphrase: string): Promise<{ recoveryKey: string }> {
  if (!passphrase) throw new Error('passphrase must not be empty');
  await sodiumReady;
  const salt = crypto.randomBytes(16);
  const kek = await crypto.deriveKek(passphrase, salt);
  const master = crypto.randomBytes(32);
  const vk = crypto.randomBytes(32);
  const wMaster = await crypto.wrapKey(kek, master);
  const wVault = await crypto.wrapKey(master, vk);
  const recoveryKeyBytes = crypto.randomBytes(32);
  const recoveryKek = await sha256(recoveryKeyBytes);
  const wRecovery = await crypto.wrapKey(recoveryKek, master);
  const keys: StoredKeys = {
    salt: toBase64(salt),
    wrapped_master: toBase64(wMaster.wrapped),
    wrapped_master_nonce: toBase64(wMaster.nonce),
    wrapped_vault: toBase64(wVault.wrapped),
    wrapped_vault_nonce: toBase64(wVault.nonce),
    wrapped_recovery: toBase64(wRecovery.wrapped),
    wrapped_recovery_nonce: toBase64(wRecovery.nonce),
  };
  await chrome.storage.local.set({ [KEYS_KEY]: keys, [ROWS_KEY]: [] });
  masterKey = master;
  vaultKey = vk;
  unlockedItems = [];
  kek.fill(0);
  recoveryKek.fill(0);
  const recoveryKey = toBase64Url(recoveryKeyBytes);
  recoveryKeyBytes.fill(0);
  return { recoveryKey };
}

export async function unlockVault(passphrase: string): Promise<boolean> {
  const keys = await loadKeys();
  if (!keys) return false;
  try {
    const kek = await crypto.deriveKek(passphrase, fromBase64(keys.salt));
    const master = await crypto.unwrapKey(
      kek,
      fromBase64(keys.wrapped_master_nonce),
      fromBase64(keys.wrapped_master),
    );
    kek.fill(0);
    return finishUnlock(master, keys);
  } catch {
    clearMemory();
    return false;
  }
}

export async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  const keys = await loadKeys();
  if (!keys) return false;
  try {
    const recoveryKek = await sha256(fromBase64Url(recoveryKey.trim()));
    const master = await crypto.unwrapKey(
      recoveryKek,
      fromBase64(keys.wrapped_recovery_nonce),
      fromBase64(keys.wrapped_recovery),
    );
    recoveryKek.fill(0);
    return finishUnlock(master, keys);
  } catch {
    clearMemory();
    return false;
  }
}

export function lockVault(): void {
  clearMemory();
}

/** Re-wrap the Master Key under a new passphrase. Items are untouched (same Master Key). */
export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<boolean> {
  const keys = await loadKeys();
  if (!keys || !masterKey) return false;
  const kek = await crypto.deriveKek(oldPassphrase, fromBase64(keys.salt));
  try {
    // Verify the old passphrase by unwrapping; throws on a wrong one.
    await crypto.unwrapKey(kek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master));
  } catch {
    kek.fill(0);
    return false;
  }
  const newSalt = crypto.randomBytes(16);
  const newKek = await crypto.deriveKek(newPassphrase, newSalt);
  const wMaster = await crypto.wrapKey(newKek, masterKey);
  kek.fill(0);
  newKek.fill(0);
  await chrome.storage.local.set({
    [KEYS_KEY]: { ...keys, salt: toBase64(newSalt), wrapped_master: toBase64(wMaster.wrapped), wrapped_master_nonce: toBase64(wMaster.nonce) },
  });
  return true;
}

/** Decrypt ONE row by id. Used for fill / detail — never decrypts the whole vault for the page. */
export async function getDecryptedItem(id: string): Promise<VaultItem | null> {
  if (!vaultKey) return null;
  const cached = unlockedItems.find((i) => i.id === id);
  if (cached) return cached;
  const row = (await loadRows()).find((r) => r.id === id);
  if (!row) return null;
  const [item] = await decryptRows([row]);
  return item ?? null;
}

export async function upsertItem(item: VaultItem): Promise<void> {
  if (!vaultKey) throw new Error('vault locked');
  await sodiumReady;
  const itemKey = crypto.randomBytes(32);
  const wrapped = await crypto.wrapKey(vaultKey, itemKey);
  const { nonce, ciphertext } = await crypto.encrypt(
    itemKey,
    new TextEncoder().encode(JSON.stringify(item)),
  );
  itemKey.fill(0);
  const rows = await loadRows();
  const existing = rows.find((r) => r.id === item.id);
  const row: StoredRow = {
    id: item.id,
    revision: (existing?.revision ?? 0) + 1,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
    wrapped_item_key: toBase64(wrapped.wrapped),
    wrapped_nonce: toBase64(wrapped.nonce),
    deleted_at: existing?.deleted_at ?? null,
  };
  await saveRows([...rows.filter((r) => r.id !== item.id), row]);
  unlockedItems = [...unlockedItems.filter((i) => i.id !== item.id), item];
}

export async function softDeleteItem(id: string): Promise<void> {
  const rows = await loadRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  row.deleted_at = new Date().toISOString();
  await saveRows(rows);
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = row.deleted_at;
}

export async function restoreItem(id: string): Promise<void> {
  const rows = await loadRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  row.deleted_at = null;
  await saveRows(rows);
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = null;
}

export async function permanentlyDeleteItem(id: string): Promise<void> {
  await saveRows((await loadRows()).filter((r) => r.id !== id));
  unlockedItems = unlockedItems.filter((i) => i.id !== id);
}

export async function exportEncrypted(): Promise<string> {
  const rows = (await loadRows()).filter((r) => !r.deleted_at);
  const exported: VaultExport = {
    format: 'my-secrect-vault-export',
    format_version: 1,
    exported_at: new Date().toISOString(),
    vault_id: 'extension-local',
    items: rows.map((r) => ({
      item_id: r.id,
      revision: r.revision,
      encrypted_payload: toBase64(
        new Uint8Array([...fromBase64(r.nonce), ...fromBase64(r.ciphertext)]),
      ),
      encrypted_item_key: toBase64(
        new Uint8Array([...fromBase64(r.wrapped_nonce), ...fromBase64(r.wrapped_item_key)]),
      ),
      encryption_version: 1,
    })),
    relations_included: true,
  };
  return JSON.stringify(exported, null, 2);
}

export async function wipeVault(): Promise<void> {
  clearMemory();
  await chrome.storage.local.remove([ROWS_KEY, KEYS_KEY]);
}
