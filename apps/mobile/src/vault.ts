/**
 * Mobile vault — same crypto + key hierarchy as apps/desktop/src/vault.ts:
 *
 *   passphrase --Argon2id (salt 16B)--> KEK
 *   KEK --wrap--> Account Master Key (random 32B)
 *   Account Master Key --wrap--> Vault Key (random 32B)
 *   Vault Key --wrap--> per-item Item Key (random 32B, fresh per write)
 *   Item Key --encrypt--> VaultItem JSON (XChaCha20-Poly1305, fresh 24B nonce)
 *
 * Recovery: 32 random bytes (base64url, shown once) hashed with SHA-256
 * to a recovery KEK that also wraps the Master Key. Lose both passphrase
 * and recovery key = lose the vault. No reset, no server copy.
 *
 * DIFFERENCES from desktop: storage is AsyncStorage (not localStorage),
 * so every storage access is async; text encode/decode uses Buffer
 * (polyfilled in index.js) because Hermes has no TextEncoder. Keys live
 * in memory only, zero-filled on lock. Production mobile storage is
 * SQLCipher (encrypted SQLite) — the StorageBackend interface is the seam.
 *
 * NOT audited, NOT production-ready.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import {
  libsodiumAdapter as crypto,
  sodiumReady,
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  sha256,
} from '../../../packages/crypto-adapters/src/index';
import type { VaultItem } from '../../../packages/core/src/types';
import {
  buildEncryptedExport,
  parseEncryptedExportText,
} from '../../../packages/import-export/src/index';
import type { EncryptedExportItem, WrappedKeyEnvelope } from '../../../packages/import-export/src/index';

const LS_KEY = 'my-secrect.local-vault.v1';
const LS_KEYS = 'my-secrect.local-vault.v1.keys';

export interface StorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
class AsyncStorageBackend implements StorageBackend {
  getItem(key: string) { return AsyncStorage.getItem(key); }
  async setItem(key: string, value: string) { await AsyncStorage.setItem(key, value); }
  async removeItem(key: string) { await AsyncStorage.removeItem(key); }
}
const storage: StorageBackend = new AsyncStorageBackend();

interface StoredRow {
  id: string; revision: number; nonce: string; ciphertext: string;
  wrapped_item_key: string; wrapped_nonce: string; deleted_at?: string | null;
}
interface StoredKeys {
  salt: string; wrapped_master: string; wrapped_master_nonce: string;
  wrapped_vault: string; wrapped_vault_nonce: string;
  wrapped_recovery: string; wrapped_recovery_nonce: string;
}
let masterKey: Uint8Array | null = null;
let vaultKey: Uint8Array | null = null;
let unlockedItems: VaultItem[] = [];

async function loadRows(): Promise<StoredRow[]> {
  try { const p: unknown = JSON.parse((await storage.getItem(LS_KEY)) ?? '[]'); return Array.isArray(p) ? (p as StoredRow[]) : []; } catch { return []; }
}
async function saveRows(rows: StoredRow[]): Promise<void> { await storage.setItem(LS_KEY, JSON.stringify(rows)); }
async function loadKeys(): Promise<StoredKeys | null> {
  const raw = await storage.getItem(LS_KEYS); if (!raw) return null;
  try { return JSON.parse(raw) as StoredKeys; } catch { return null; }
}
function clearMemory(): void { masterKey?.fill(0); vaultKey?.fill(0); masterKey = null; vaultKey = null; unlockedItems = []; }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
function splitNoncePrefixed(encoded: string): { nonce: Uint8Array; rest: Uint8Array } {
  const bytes = fromBase64(encoded); if (bytes.length < 24) throw new Error('encrypted blob too short');
  return { nonce: bytes.subarray(0, 24), rest: bytes.subarray(24) };
}
function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
async function decryptRows(rows: StoredRow[]): Promise<VaultItem[]> {
  if (!vaultKey) throw new Error('vault locked');
  const items: VaultItem[] = [];
  for (const row of rows) {
    let itemKey: Uint8Array | null = null;
    try {
      itemKey = await crypto.unwrapKey(vaultKey, fromBase64(row.wrapped_nonce), fromBase64(row.wrapped_item_key));
      const plaintext = await crypto.decrypt(itemKey, fromBase64(row.nonce), fromBase64(row.ciphertext));
      const item = JSON.parse(decodeUtf8(plaintext)) as VaultItem;
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
    vaultKey = await crypto.unwrapKey(master, fromBase64(keys.wrapped_vault_nonce), fromBase64(keys.wrapped_vault));
    unlockedItems = await decryptRows(await loadRows());
    return true;
  } catch { clearMemory(); return false; }
}

export async function hasVault(): Promise<boolean> { return (await storage.getItem(LS_KEYS)) !== null; }

export async function createVault(passphrase: string): Promise<{ recoveryKey: string }> {
  if (!passphrase) throw new Error('passphrase must not be empty');
  await sodiumReady;
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
  await storage.setItem(LS_KEYS, JSON.stringify(keys));
  masterKey = master; vaultKey = vk; unlockedItems = [];
  await saveRows([]);
  kek.fill(0); recoveryKek.fill(0);
  const recoveryKey = toBase64Url(recoveryKeyBytes); recoveryKeyBytes.fill(0);
  return { recoveryKey };
}

export async function unlockVault(passphrase: string): Promise<boolean> {
  const keys = await loadKeys(); if (!keys) return false;
  try {
    const kek = await crypto.deriveKek(passphrase, fromBase64(keys.salt));
    const master = await crypto.unwrapKey(kek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master));
    kek.fill(0); return finishUnlock(master, keys);
  } catch { clearMemory(); return false; }
}

export async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  const keys = await loadKeys(); if (!keys) return false;
  try {
    const rb = fromBase64Url(recoveryKey.trim()); if (rb.length !== 32) return false;
    const rk = await sha256(rb); rb.fill(0);
    const master = await crypto.unwrapKey(rk, fromBase64(keys.wrapped_recovery_nonce), fromBase64(keys.wrapped_recovery));
    rk.fill(0); return finishUnlock(master, keys);
  } catch { clearMemory(); return false; }
}

/**
 * Verify a passphrase WITHOUT disturbing the in-memory session: derives
 * the KEK and unwraps the Master Key into a throwaway copy, then
 * zero-fills it. Used for step-up prompts (export / change passphrase /
 * wipe) so a wrong entry can never lock a vault that is already open —
 * unlike unlockVault(), which clears memory on failure. Never stores
 * the passphrase.
 */
export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  const keys = await loadKeys(); if (!keys) return false;
  try {
    const kek = await crypto.deriveKek(passphrase, fromBase64(keys.salt));
    const master = await crypto.unwrapKey(kek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master));
    kek.fill(0); master.fill(0);
    return true;
  } catch { return false; }
}

/**
 * Encrypt / decrypt short display strings (e.g. device names) with the
 * in-memory Vault Key, as nonce-prefixed base64 (24-byte nonce ||
 * ciphertext) — the same envelope layout exportEncrypted() uses for item
 * payloads. The server stores name_encrypted opaquely and can never
 * decrypt it. encrypt throws when the vault is locked; decrypt returns
 * null when locked, tampered with, or malformed.
 */
export async function encryptWithVaultKey(text: string): Promise<string> {
  if (!vaultKey) throw new Error('vault locked');
  await sodiumReady;
  const { nonce, ciphertext } = await crypto.encrypt(vaultKey, Buffer.from(text, 'utf8'));
  return toBase64(concat(nonce, ciphertext));
}
export async function decryptWithVaultKey(encoded: string): Promise<string | null> {
  if (!vaultKey) return null;
  try {
    const { nonce, rest } = splitNoncePrefixed(encoded);
    const plaintext = await crypto.decrypt(vaultKey, nonce, rest);
    return Buffer.from(plaintext).toString('utf8');
  } catch { return null; }
}

export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
  if (!newPassphrase || newPassphrase.length < 8) throw new Error('new passphrase must be at least 8 characters');
  const keys = await loadKeys(); if (!keys) throw new Error('no vault exists');
  await sodiumReady;
  const oldKek = await crypto.deriveKek(oldPassphrase, fromBase64(keys.salt));
  let master: Uint8Array;
  try { master = await crypto.unwrapKey(oldKek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master)); }
  catch { oldKek.fill(0); throw new Error('current passphrase is incorrect'); }
  oldKek.fill(0);
  const newSalt = crypto.randomBytes(16);
  const newKek = await crypto.deriveKek(newPassphrase, newSalt);
  const wMaster = await crypto.wrapKey(newKek, master);
  newKek.fill(0); master.fill(0);
  await storage.setItem(LS_KEYS, JSON.stringify({ ...keys, salt: toBase64(newSalt), wrapped_master: toBase64(wMaster.wrapped), wrapped_master_nonce: toBase64(wMaster.nonce) }));
}

export async function wipeVault(): Promise<void> { await storage.removeItem(LS_KEY); await storage.removeItem(LS_KEYS); clearMemory(); }
export function exportPlaintext(): string {
  if (!vaultKey) throw new Error('vault locked');
  return JSON.stringify({ format: 'my-secrect-vault-plaintext-export', format_version: 1, exported_at: new Date().toISOString(), vault_id: 'local', items: listItems() }, null, 2);
}
export function lockVault(): void { clearMemory(); }
export function isUnlocked(): boolean { return vaultKey !== null; }
function isDeleted(item: VaultItem): boolean { return item.deleted_at != null; }
export function listItems(includeDeleted = false): VaultItem[] { return includeDeleted ? [...unlockedItems] : unlockedItems.filter((i) => !isDeleted(i)); }
export function listTrash(): VaultItem[] { return unlockedItems.filter((i) => isDeleted(i)); }

export async function upsertItem(item: VaultItem): Promise<void> {
  if (!vaultKey) throw new Error('vault locked');
  if (!item.id) throw new Error('item id must not be empty');
  await sodiumReady;
  const now = new Date().toISOString();
  const stored: VaultItem = { ...item, favorite: item.favorite ?? false, deleted_at: null, updated_at: now, created_at: item.created_at || now };
  const itemKey = crypto.randomBytes(32);
  const wrapped = await crypto.wrapKey(vaultKey, itemKey);
  const { nonce, ciphertext } = await crypto.encrypt(itemKey, Buffer.from(JSON.stringify(stored), 'utf8'));
  itemKey.fill(0);
  const rows = await loadRows();
  const existing = rows.find((r) => r.id === stored.id);
  const row: StoredRow = { id: stored.id, revision: (existing?.revision ?? 0) + 1, nonce: toBase64(nonce), ciphertext: toBase64(ciphertext), wrapped_item_key: toBase64(wrapped.wrapped), wrapped_nonce: toBase64(wrapped.nonce), deleted_at: null };
  await saveRows([...rows.filter((r) => r.id !== stored.id), row]);
  unlockedItems = [...unlockedItems.filter((i) => i.id !== stored.id), stored];
}

export async function deleteItem(id: string): Promise<void> {
  const now = new Date().toISOString(); const rows = await loadRows();
  const row = rows.find((r) => r.id === id); if (row) { row.deleted_at = now; await saveRows(rows); }
  const item = unlockedItems.find((i) => i.id === id); if (item) item.deleted_at = now;
}
export async function restoreItem(id: string): Promise<void> {
  const rows = await loadRows(); const row = rows.find((r) => r.id === id);
  if (row) { row.deleted_at = null; await saveRows(rows); }
  const item = unlockedItems.find((i) => i.id === id); if (item) item.deleted_at = null;
}
export async function permanentlyDeleteItem(id: string): Promise<void> {
  await saveRows((await loadRows()).filter((r) => r.id !== id));
  unlockedItems = unlockedItems.filter((i) => i.id !== id);
}
export function toggleFavorite(id: string): void {
  const item = unlockedItems.find((i) => i.id === id); if (!item) return;
  const flipped: VaultItem = { ...item, favorite: !item.favorite };
  unlockedItems = unlockedItems.map((i) => (i.id === id ? flipped : i));
  void upsertItem(flipped).catch(() => { unlockedItems = unlockedItems.map((i) => (i.id === id ? item : i)); });
}
export function searchLocal(q: string): VaultItem[] {
  const s = q.trim().toLowerCase(); if (!s) return listItems();
  return listItems().filter((i) => (i.title + ' ' + i.tags.join(' ') + ' ' + JSON.stringify(i.fields)).toLowerCase().includes(s));
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
async function openExportItem(key: Uint8Array, item: EncryptedExportItem, purpose: 'import' | 'restore'): Promise<VaultItem> {
  const idError = `${purpose}: decrypted item id does not match item_id`;
  const decryptError = `${purpose}: could not decrypt item`;
  let itemKey: Uint8Array | null = null;
  try {
    const payload = splitNoncePrefixed(item.encrypted_payload);
    const wrapped = splitNoncePrefixed(item.encrypted_item_key);
    itemKey = await crypto.unwrapKey(key, wrapped.nonce, wrapped.rest);
    const plaintext = await crypto.decrypt(itemKey, payload.nonce, payload.rest);
    const decoded = JSON.parse(decodeUtf8(plaintext)) as VaultItem;
    if (typeof decoded !== 'object' || decoded === null || decoded.id !== item.item_id) throw new Error(idError);
    return decoded;
  } catch (err) {
    if (err instanceof Error && err.message === idError) throw err;
    throw new Error(decryptError);
  } finally {
    itemKey?.fill(0);
  }
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
  if ((await storage.getItem(LS_KEYS)) !== null) return true;
  const raw = await storage.getItem(LS_KEY);
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return true;
    return parsed.length > 0;
  } catch {
    return true;
  }
}
async function persistRestoredVault(keys: StoredKeys, rows: StoredRow[]): Promise<void> {
  const priorKeys = await storage.getItem(LS_KEYS);
  const priorRows = await storage.getItem(LS_KEY);
  if (priorKeys !== null || await vaultStorageOccupied()) throw new Error('restore: vault storage is not empty');
  try {
    await storage.setItem(LS_KEYS, JSON.stringify(keys));
    await storage.setItem(LS_KEY, JSON.stringify(rows));
  } catch (err) {
    if (priorKeys === null) await storage.removeItem(LS_KEYS);
    else await storage.setItem(LS_KEYS, priorKeys);
    if (priorRows === null) await storage.removeItem(LS_KEY);
    else await storage.setItem(LS_KEY, priorRows);
    throw err instanceof Error ? err : new Error('restore: could not write the vault');
  }
}
/** format_version 2. Item cipher stays encryption_version 1. Envelope is the wrapped keys already stored locally. */
export async function exportEncrypted(): Promise<string> {
  const keys = await loadKeys();
  if (!keys) throw new Error('export: vault has no wrapped key envelope');
  const items = (await loadRows()).filter((r) => !r.deleted_at).map((r) => ({
    item_id: r.id,
    revision: r.revision,
    encrypted_payload: toBase64(concat(fromBase64(r.nonce), fromBase64(r.ciphertext))),
    encrypted_item_key: toBase64(concat(fromBase64(r.wrapped_nonce), fromBase64(r.wrapped_item_key))),
    encryption_version: 1 as const,
  }));
  return JSON.stringify(buildEncryptedExport({ vaultId: 'local', keys, items }));
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
 * Empty storage plus this file plus a passphrase or recovery key.
 * Uses the same KEK as unlock. Writes nothing until every item decrypts
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
export function getVaultStats(): { total: number; favorites: number; trash: number } {
  const live = unlockedItems.filter((i) => !isDeleted(i));
  return { total: live.length, favorites: live.filter((i) => i.favorite).length, trash: unlockedItems.filter((i) => isDeleted(i)).length };
}
