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
import {
  buildEncryptedExport,
  parseEncryptedExportText,
} from '../../../../packages/import-export/src/index';
import type { EncryptedExportItem, WrappedKeyEnvelope } from '../../../../packages/import-export/src/index';

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
    let itemKey: Uint8Array | null = null;
    try {
      itemKey = await crypto.unwrapKey(
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
      if (typeof item !== 'object' || item === null || item.id !== row.id) {
        throw new Error('vault: decrypted item id does not match stored row id');
      }
      if (row.deleted_at) item.deleted_at = row.deleted_at;
      items.push(item);
    } finally {
      itemKey?.fill(0);
    }
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
  // Never silently overwrite an existing vault (would destroy all ciphertext).
  if (await loadKeys()) throw new Error('A vault already exists. Wipe it explicitly before creating a new one.');
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
  // Phase F fix: reject an empty new passphrase here too (the options page
  // also validates, but the background must not rely on the caller).
  if (!keys || !masterKey || !newPassphrase) return false;
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

function rowFromExportItem(item: EncryptedExportItem): StoredRow {
  const payload = splitNoncePrefixed(item.encrypted_payload);
  const wrapped = splitNoncePrefixed(item.encrypted_item_key);
  return {
    id: item.item_id,
    revision: item.revision,
    nonce: toBase64(payload.nonce),
    ciphertext: toBase64(payload.rest),
    wrapped_item_key: toBase64(wrapped.rest),
    wrapped_nonce: toBase64(wrapped.nonce),
    deleted_at: null,
  };
}

async function openExportItem(
  key: Uint8Array,
  item: EncryptedExportItem,
  purpose: 'import' | 'restore',
): Promise<VaultItem> {
  const idError = `${purpose}: decrypted item id does not match item_id`;
  const decryptError = `${purpose}: could not decrypt item`;
  let itemKey: Uint8Array | null = null;
  try {
    const payload = splitNoncePrefixed(item.encrypted_payload);
    const wrapped = splitNoncePrefixed(item.encrypted_item_key);
    itemKey = await crypto.unwrapKey(key, wrapped.nonce, wrapped.rest);
    const plaintext = await crypto.decrypt(itemKey, payload.nonce, payload.rest);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as VaultItem;
    if (typeof decoded !== 'object' || decoded === null || decoded.id !== item.item_id) {
      throw new Error(idError);
    }
    return decoded;
  } catch (err) {
    if (err instanceof Error && err.message === idError) throw err;
    throw new Error(decryptError);
  } finally {
    itemKey?.fill(0);
  }
}

function splitNoncePrefixed(encoded: string): { nonce: Uint8Array; rest: Uint8Array } {
  const bytes = fromBase64(encoded);
  if (bytes.length < 24) throw new Error('encrypted blob too short');
  return { nonce: bytes.subarray(0, 24), rest: bytes.subarray(24) };
}

function envelopeToStoredKeys(keys: WrappedKeyEnvelope): StoredKeys {
  return {
    salt: keys.salt,
    wrapped_master: keys.wrapped_master,
    wrapped_master_nonce: keys.wrapped_master_nonce,
    wrapped_vault: keys.wrapped_vault,
    wrapped_vault_nonce: keys.wrapped_vault_nonce,
    wrapped_recovery: keys.wrapped_recovery,
    wrapped_recovery_nonce: keys.wrapped_recovery_nonce,
  };
}

async function vaultStorageOccupied(): Promise<boolean> {
  if (await loadKeys()) return true;
  return (await loadRows()).length > 0;
}

async function persistRestoredVault(keys: StoredKeys, rows: StoredRow[]): Promise<void> {
  const prior = await chrome.storage.local.get([KEYS_KEY, ROWS_KEY]);
  if (await vaultStorageOccupied()) throw new Error('restore: vault storage is not empty');
  try {
    await chrome.storage.local.set({ [KEYS_KEY]: keys, [ROWS_KEY]: rows });
  } catch (err) {
    if (prior[KEYS_KEY] === undefined && prior[ROWS_KEY] === undefined) {
      await chrome.storage.local.remove([KEYS_KEY, ROWS_KEY]);
    } else {
      await chrome.storage.local.set({ [KEYS_KEY]: prior[KEYS_KEY], [ROWS_KEY]: prior[ROWS_KEY] });
    }
    throw err instanceof Error ? err : new Error('restore: could not write the vault');
  }
}

/** format_version 2, same envelope as desktop and mobile. Item cipher stays encryption_version 1. */
export async function exportEncrypted(): Promise<string> {
  const keys = await loadKeys();
  if (!keys) throw new Error('export: vault has no wrapped key envelope');
  const rows = (await loadRows()).filter((r) => !r.deleted_at);
  return JSON.stringify(buildEncryptedExport({
    vaultId: 'extension-local',
    keys,
    items: rows.map((r) => ({
      item_id: r.id,
      revision: r.revision,
      encrypted_payload: toBase64(new Uint8Array([...fromBase64(r.nonce), ...fromBase64(r.ciphertext)])),
      encrypted_item_key: toBase64(new Uint8Array([...fromBase64(r.wrapped_nonce), ...fromBase64(r.wrapped_item_key)])),
      encryption_version: 1 as const,
    })),
  }));
}

/** Merge into an unlocked vault. Decrypt failure aborts with no partial write. */
export async function importEncrypted(json: string): Promise<void> {
  if (!vaultKey) throw new Error('vault locked');
  const { validation, data } = parseEncryptedExportText(json);
  if (!validation.ok || !data) throw new Error(`import: ${validation.errors.join(' ')}`);
  const opened: Array<{ item: VaultItem; row: StoredRow }> = [];
  for (const item of data.items) {
    const decrypted = await openExportItem(vaultKey, item, 'import');
    decrypted.deleted_at = null;
    opened.push({ item: decrypted, row: rowFromExportItem(item) });
  }
  const nextRows = (await loadRows()).map((row) => ({ ...row }));
  let nextItems = [...unlockedItems];
  for (const { item, row } of opened) {
    const existing = nextRows.find((r) => r.id === row.id);
    if (existing && existing.revision >= row.revision) continue;
    const idx = nextRows.findIndex((r) => r.id === row.id);
    if (idx >= 0) nextRows[idx] = row;
    else nextRows.push(row);
    nextItems = [...nextItems.filter((i) => i.id !== item.id), item];
  }
  await saveRows(nextRows);
  unlockedItems = nextItems;
}

export type VaultRestoreSecret =
  | { passphrase: string; recoveryKey?: undefined }
  | { recoveryKey: string; passphrase?: undefined };

/**
 * Empty extension storage plus the backup file plus a passphrase or
 * recovery key. Same KEK as unlock. No write until every item decrypts
 * and each decrypted id matches item_id.
 */
export async function restoreEncrypted(json: string, secret: VaultRestoreSecret): Promise<void> {
  if (isUnlocked()) throw new Error('restore: lock and wipe the vault before restoring');
  if (await vaultStorageOccupied()) throw new Error('restore: vault storage is not empty');
  const { validation, data } = parseEncryptedExportText(json);
  if (!validation.ok || !data) throw new Error(`restore: ${validation.errors.join(' ')}`);
  const hasPassphrase = typeof secret.passphrase === 'string';
  const hasRecovery = typeof secret.recoveryKey === 'string';
  if (hasPassphrase === hasRecovery) throw new Error('restore: provide a passphrase or a recovery key, not both');
  await sodiumReady;
  let master: Uint8Array | null = null;
  let vk: Uint8Array | null = null;
  let published = false;
  try {
    if (hasPassphrase) {
      const passphrase = secret.passphrase ?? '';
      if (!passphrase) throw new Error('restore: passphrase must not be empty');
      const kek = await crypto.deriveKek(passphrase, fromBase64(data.keys.salt));
      try {
        master = await crypto.unwrapKey(kek, fromBase64(data.keys.wrapped_master_nonce), fromBase64(data.keys.wrapped_master));
      } catch {
        throw new Error('restore: could not open the backup with this passphrase');
      } finally {
        kek.fill(0);
      }
    } else {
      const recoveryKey = (secret.recoveryKey ?? '').trim();
      let recoveryKeyBytes: Uint8Array;
      try { recoveryKeyBytes = fromBase64Url(recoveryKey); } catch { throw new Error('restore: recovery key must be 32 bytes'); }
      if (recoveryKeyBytes.length !== 32) {
        recoveryKeyBytes.fill(0);
        throw new Error('restore: recovery key must be 32 bytes');
      }
      const recoveryKek = await sha256(recoveryKeyBytes);
      recoveryKeyBytes.fill(0);
      try {
        master = await crypto.unwrapKey(recoveryKek, fromBase64(data.keys.wrapped_recovery_nonce), fromBase64(data.keys.wrapped_recovery));
      } catch {
        throw new Error('restore: could not open the backup with this recovery key');
      } finally {
        recoveryKek.fill(0);
      }
    }
    if (!master) throw new Error('restore: could not open the backup');
    try {
      vk = await crypto.unwrapKey(master, fromBase64(data.keys.wrapped_vault_nonce), fromBase64(data.keys.wrapped_vault));
    } catch {
      throw new Error('restore: could not unwrap the vault key');
    }
    if (!vk) throw new Error('restore: could not unwrap the vault key');
    const opened: VaultItem[] = [];
    const rows: StoredRow[] = [];
    for (const item of data.items) {
      const decrypted = await openExportItem(vk, item, 'restore');
      decrypted.deleted_at = null;
      opened.push(decrypted);
      rows.push(rowFromExportItem(item));
    }
    await persistRestoredVault(envelopeToStoredKeys(data.keys), rows);
    masterKey = master;
    vaultKey = vk;
    unlockedItems = opened;
    published = true;
  } catch (err) {
    if (!published) {
      master?.fill(0);
      vk?.fill(0);
      if (masterKey === master) masterKey = null;
      if (vaultKey === vk) vaultKey = null;
    }
    throw err;
  }
}

export async function wipeVault(): Promise<void> {
  clearMemory();
  await chrome.storage.local.remove([ROWS_KEY, KEYS_KEY]);
}
