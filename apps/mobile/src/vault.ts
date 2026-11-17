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
export interface VaultExport {
  format: 'my-secrect-vault-export'; format_version: 1; exported_at: string;
  vault_id: 'local';
  items: Array<{ item_id: string; revision: number; encrypted_payload: string; encrypted_item_key: string; encryption_version: number }>;
  relations_included: true;
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
async function decryptRows(rows: StoredRow[]): Promise<VaultItem[]> {
  if (!vaultKey) throw new Error('vault locked');
  const items: VaultItem[] = [];
  for (const row of rows) {
    const itemKey = await crypto.unwrapKey(vaultKey, fromBase64(row.wrapped_nonce), fromBase64(row.wrapped_item_key));
    const plaintext = await crypto.decrypt(itemKey, fromBase64(row.nonce), fromBase64(row.ciphertext));
    const item = JSON.parse(Buffer.from(plaintext).toString('utf8')) as VaultItem;
    if (row.deleted_at) item.deleted_at = row.deleted_at;
    items.push(item); itemKey.fill(0);
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
export async function exportEncrypted(): Promise<string> {
  const items = (await loadRows()).filter((r) => !r.deleted_at).map((r) => ({
    item_id: r.id, revision: r.revision,
    encrypted_payload: toBase64(concat(fromBase64(r.nonce), fromBase64(r.ciphertext))),
    encrypted_item_key: toBase64(concat(fromBase64(r.wrapped_nonce), fromBase64(r.wrapped_item_key))),
    encryption_version: 1,
  }));
  const out: VaultExport = { format: 'my-secrect-vault-export', format_version: 1, exported_at: new Date().toISOString(), vault_id: 'local', items, relations_included: true };
  return JSON.stringify(out);
}
export async function importEncrypted(json: string): Promise<void> {
  if (!vaultKey) throw new Error('vault locked');
  let parsed: unknown; try { parsed = JSON.parse(json); } catch { throw new Error('import: invalid JSON'); }
  const data = parsed as Partial<VaultExport>;
  if (data.format !== 'my-secrect-vault-export' || data.format_version !== 1 || !Array.isArray(data.items)) throw new Error('import: unsupported vault export format');
  const rows = await loadRows();
  for (const item of data.items) {
    if (typeof item.item_id !== 'string' || !item.item_id || typeof item.revision !== 'number' || typeof item.encrypted_payload !== 'string' || typeof item.encrypted_item_key !== 'string') throw new Error('import: malformed item in export');
    const existing = rows.find((r) => r.id === item.item_id);
    if (existing && existing.revision >= item.revision) continue;
    let decrypted: VaultItem;
    try {
      const payload = splitNoncePrefixed(item.encrypted_payload); const wrapped = splitNoncePrefixed(item.encrypted_item_key);
      const itemKey = await crypto.unwrapKey(vaultKey, wrapped.nonce, wrapped.rest);
      const plaintext = await crypto.decrypt(itemKey, payload.nonce, payload.rest);
      itemKey.fill(0); decrypted = JSON.parse(Buffer.from(plaintext).toString('utf8')) as VaultItem;
      if (decrypted.id !== item.item_id) continue;
    } catch { continue; }
    const row: StoredRow = { id: item.item_id, revision: item.revision, nonce: toBase64(splitNoncePrefixed(item.encrypted_payload).nonce), ciphertext: toBase64(splitNoncePrefixed(item.encrypted_payload).rest), wrapped_item_key: toBase64(splitNoncePrefixed(item.encrypted_item_key).rest), wrapped_nonce: toBase64(splitNoncePrefixed(item.encrypted_item_key).nonce), deleted_at: null };
    const idx = rows.findIndex((r) => r.id === item.item_id);
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    decrypted.deleted_at = null;
    unlockedItems = [...unlockedItems.filter((i) => i.id !== decrypted.id), decrypted];
  }
  await saveRows(rows);
}
export function getVaultStats(): { total: number; favorites: number; trash: number } {
  const live = unlockedItems.filter((i) => !isDeleted(i));
  return { total: live.length, favorites: live.filter((i) => i.favorite).length, trash: unlockedItems.filter((i) => isDeleted(i)).length };
}
