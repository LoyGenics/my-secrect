/**
 * Local vault (Phase 1 prototype) — desktop only, NO server.
 *
 * Key hierarchy (all keys 32 bytes, all wrapping/encryption is
 * XChaCha20-Poly1305 via `libsodiumAdapter`):
 *
 *   passphrase --Argon2id (salt 16B)--> KEK
 *   KEK --wrap--> Account Master Key (random 32B)
 *   Account Master Key --wrap--> Vault Key (random 32B)
 *   Vault Key --wrap--> per-item Item Key (random 32B, fresh per item write)
 *   Item Key --encrypt--> VaultItem JSON (XChaCha20-Poly1305, fresh 24B nonce)
 *
 * Recovery: a 32-byte random recovery key (base64url, shown once at
 * creation) is hashed with SHA-256 (`sodium.crypto_hash_sha256`) to a
 * recovery KEK, which also wraps the Account Master Key. Losing both the
 * passphrase and the recovery key loses the vault — there is no reset.
 *
 * Storage here is localStorage for the prototype. Production desktop uses
 * SQLCipher (encrypted SQLite) via Tauri — the `StorageBackend` interface
 * below is the seam: implement it against SQLCipher and swap the single
 * `storage` binding, without touching the crypto or item logic.
 *
 * Keys live in memory only, never in plaintext on disk, and are
 * zero-filled and cleared on lock. Encrypted rows + wrapped keys are
 * what localStorage holds.
 *
 * This file is NOT audited and NOT production-ready.
 */
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
import type { LocalItemState, PushRequest, SyncEvent } from '../../../packages/sync/src/index';
import {
  buildEncryptedExport,
  parseEncryptedExportText,
  sealItemIndex,
  verifyItemIndex,
} from '../../../packages/import-export/src/index';
import type { EncryptedExportItem, ItemListCheck, WrappedKeyEnvelope } from '../../../packages/import-export/src/index';
import { selectStorageBackend } from './storage/index';

const LS_KEY = 'my-secrect.local-vault.v1';
const LS_KEYS = 'my-secrect.local-vault.v1.keys';

/** Minimal key/value storage seam. SQLCipher replaces this backend later. */
export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage backend for the prototype. Production: SQLCipher. */
export class LocalStorageBackend implements StorageBackend {
  getItem(key: string): string | null {
    return localStorage.getItem(key);
  }
  setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
  }
  removeItem(key: string): void {
    localStorage.removeItem(key);
  }
}

// Tauri desktop: SQLCipher store (key in the OS keychain), migrating these
// localStorage keys once. Web/tests: the localStorage backend above.
const storage: StorageBackend = selectStorageBackend({
  fallback: () => new LocalStorageBackend(),
  migrateKeys: [LS_KEY, LS_KEYS],
});

/** One encrypted row. Nonce and ciphertext are stored as separate base64 fields. */
interface StoredRow {
  id: string;
  revision: number;
  nonce: string; // base64, 24 bytes
  ciphertext: string; // base64, plaintext + 16-byte Poly1305 tag
  wrapped_item_key: string; // base64, Vault-Key-wrapped Item Key (ciphertext only)
  wrapped_nonce: string; // base64, 24 bytes
  deleted_at?: string | null; // tombstone; null/undefined = live
  /** Last server revision this device has synced for the item. Absent = never synced (0).
   *  `revision > base_revision` means a local change is pending push. */
  base_revision?: number;
  /** Deleted forever on this device while the server did not have its delete yet:
   *  a content-free tombstone (ciphertext fields are '') kept only until sync
   *  pushes the delete, then removed. Never decrypted, listed or exported. */
  purged?: boolean;
}

interface StoredKeys {
  salt: string; // base64, 16 bytes (Argon2id salt for the passphrase KEK)
  wrapped_master: string; // base64, KEK-wrapped Account Master Key
  wrapped_master_nonce: string; // base64, 24 bytes
  wrapped_vault: string; // base64, Master-Key-wrapped Vault Key
  wrapped_vault_nonce: string; // base64, 24 bytes
  wrapped_recovery: string; // base64, recovery-KEK-wrapped Account Master Key
  wrapped_recovery_nonce: string; // base64, 24 bytes
}

// In-memory state only. Cleared (and zero-filled) on lock.
let masterKey: Uint8Array | null = null;
let vaultKey: Uint8Array | null = null;
let unlockedItems: VaultItem[] = [];

function loadRows(): StoredRow[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as StoredRow[]) : [];
  } catch {
    return [];
  }
}
function saveRows(rows: StoredRow[]): void {
  storage.setItem(LS_KEY, JSON.stringify(rows));
}
function loadKeys(): StoredKeys | null {
  const raw = storage.getItem(LS_KEYS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredKeys;
  } catch {
    return null;
  }
}

function clearMemory(): void {
  masterKey?.fill(0);
  vaultKey?.fill(0);
  masterKey = null;
  vaultKey = null;
  unlockedItems = [];
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Split a `nonce (24B) || rest` base64 blob (export format) into its parts. */
function splitNoncePrefixed(encoded: string): { nonce: Uint8Array; rest: Uint8Array } {
  const bytes = fromBase64(encoded);
  if (bytes.length < 24) throw new Error('encrypted blob too short');
  return { nonce: bytes.subarray(0, 24), rest: bytes.subarray(24) };
}

/** Decrypt every row with the in-memory Vault Key. Throws on any bad row
 *  or when the decrypted VaultItem.id does not match the stored row id.
 *  A failing row is not included in the returned list. */
async function decryptRows(rows: StoredRow[]): Promise<VaultItem[]> {
  if (!vaultKey) throw new Error('vault locked');
  const items: VaultItem[] = [];
  for (const row of rows) {
    if (row.purged) continue; // content-free tombstone waiting for sync
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
      // Tombstone state lives on the row (metadata), not in the payload.
      if (row.deleted_at) item.deleted_at = row.deleted_at;
      items.push(item);
    } finally {
      itemKey?.fill(0);
    }
  }
  return items;
}

/** Shared unlock tail: unwrap Vault Key from Master Key, decrypt all rows. */
async function finishUnlock(master: Uint8Array, keys: StoredKeys): Promise<boolean> {
  try {
    masterKey = master;
    vaultKey = await crypto.unwrapKey(
      master,
      fromBase64(keys.wrapped_vault_nonce),
      fromBase64(keys.wrapped_vault),
    );
    unlockedItems = await decryptRows(loadRows());
    return true;
  } catch {
    clearMemory();
    return false;
  }
}

export function hasVault(): boolean {
  return storage.getItem(LS_KEYS) !== null;
}

/**
 * Create a fresh local vault, overwriting any existing one.
 * Returns the recovery key (32 random bytes, base64url) for ONE-TIME
 * display: it is the only way back in if the passphrase is forgotten.
 * It is never stored in plaintext — only its SHA-256-derived KEK's
 * wrapping of the Master Key is stored.
 */
export async function createVault(passphrase: string): Promise<{ recoveryKey: string }> {
  if (!passphrase) throw new Error('passphrase must not be empty');
  // randomBytes is synchronous, so await readiness BEFORE its first use.
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
  storage.setItem(LS_KEYS, JSON.stringify(keys));
  masterKey = master;
  vaultKey = vk;
  unlockedItems = [];
  saveRows([]);
  kek.fill(0);
  recoveryKek.fill(0);
  const recoveryKey = toBase64Url(recoveryKeyBytes);
  recoveryKeyBytes.fill(0);
  return { recoveryKey };
}

export async function unlockVault(passphrase: string): Promise<boolean> {
  const keys = loadKeys();
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

/**
 * Unlock with the one-time recovery key from `createVault`.
 * Derives the recovery KEK as SHA-256(recovery key bytes) and unwraps
 * the Account Master Key from `wrapped_recovery`; the wrap is verified
 * by the AEAD authentication tag — a wrong recovery key fails here.
 */
export async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  const keys = loadKeys();
  if (!keys) return false;
  try {
    const recoveryKeyBytes = fromBase64Url(recoveryKey.trim());
    if (recoveryKeyBytes.length !== 32) return false;
    const recoveryKek = await sha256(recoveryKeyBytes);
    recoveryKeyBytes.fill(0);
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

/**
 * Verify a passphrase WITHOUT unlocking or locking anything: derive its
 * KEK and try unwrapping the stored Account Master Key. The AEAD tag
 * decides — a wrong passphrase fails the unwrap and returns false.
 *
 * This is the check step-up uses, and it deliberately does NOT call
 * unlockVault: unlockVault's failure path calls clearMemory(), which
 * would LOCK the vault (wiping the in-memory keys and items) after a
 * single mistyped step-up passphrase. verifyPassphrase never touches
 * the in-memory keys; every derived value is zero-filled here.
 */
export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  if (!passphrase) return false;
  const keys = loadKeys();
  if (!keys) return false;
  try {
    const kek = await crypto.deriveKek(passphrase, fromBase64(keys.salt));
    let master: Uint8Array;
    try {
      master = await crypto.unwrapKey(
        kek,
        fromBase64(keys.wrapped_master_nonce),
        fromBase64(keys.wrapped_master),
      );
    } catch {
      kek.fill(0);
      return false;
    }
    kek.fill(0);
    master.fill(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a short display string (e.g. a device name) under the
 * in-memory Vault Key and return base64 `nonce (24B) || ciphertext` —
 * the same construction as the export format. The server stores the
 * result opaquely; only a client holding the Vault Key can read it.
 * Throws when the vault is locked. The plaintext string itself is a
 * JS string and cannot be zero-filled; callers clear their input state.
 */
export async function encryptWithVaultKey(plaintext: string): Promise<string> {
  if (!vaultKey) throw new Error('vault locked');
  await sodiumReady;
  const { nonce, ciphertext } = await crypto.encrypt(
    vaultKey,
    new TextEncoder().encode(plaintext),
  );
  return toBase64(concat(nonce, ciphertext));
}

/** Decrypt a value produced by encryptWithVaultKey. Throws when the
 *  vault is locked or the value is undecryptable under this Vault Key. */
export async function decryptWithVaultKey(encoded: string): Promise<string> {
  if (!vaultKey) throw new Error('vault locked');
  const { nonce, rest } = splitNoncePrefixed(encoded);
  const plaintext = await crypto.decrypt(vaultKey, nonce, rest);
  return new TextDecoder().decode(plaintext);
}

/**
 * Run `fn` with a COPY of the in-memory Vault Key (zero-filled afterwards).
 * Used by the media pipeline, which wraps a per-file File Key under the
 * Vault Key and decrypts the encrypted manifest. Throws when locked.
 */
export async function withVaultKey<T>(fn: (key: Uint8Array) => Promise<T>): Promise<T> {
  if (!vaultKey) throw new Error('vault locked');
  const copy = vaultKey.slice();
  try {
    return await fn(copy);
  } finally {
    copy.fill(0);
  }
}

/**
 * Change the master passphrase. Verifies the OLD passphrase first
 * (derives its KEK and unwraps the Account Master Key — a wrong old
 * passphrase fails the AEAD unwrap and nothing is changed), then
 * re-wraps the SAME Account Master Key under a NEW KEK derived from
 * the new passphrase with a fresh salt. The Vault Key and every Item
 * Key are wrapped by the Master Key, not by the KEK, so no item needs
 * re-encryption and no data is lost. The recovery wrapping is
 * unchanged, so the existing recovery key still works.
 */
export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
  if (!newPassphrase || newPassphrase.length < 8) {
    throw new Error('new passphrase must be at least 8 characters');
  }
  const keys = loadKeys();
  if (!keys) throw new Error('no vault exists');
  await sodiumReady;
  // Verify the old passphrase by unwrapping the Master Key with it.
  const oldKek = await crypto.deriveKek(oldPassphrase, fromBase64(keys.salt));
  let master: Uint8Array;
  try {
    master = await crypto.unwrapKey(oldKek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master));
  } catch {
    oldKek.fill(0);
    throw new Error('current passphrase is incorrect');
  }
  oldKek.fill(0);
  // Re-wrap the same Master Key under a new KEK with a fresh salt.
  const newSalt = crypto.randomBytes(16);
  const newKek = await crypto.deriveKek(newPassphrase, newSalt);
  const wMaster = await crypto.wrapKey(newKek, master);
  newKek.fill(0);
  master.fill(0);
  const updated: StoredKeys = {
    ...keys,
    salt: toBase64(newSalt),
    wrapped_master: toBase64(wMaster.wrapped),
    wrapped_master_nonce: toBase64(wMaster.nonce),
  };
  storage.setItem(LS_KEYS, JSON.stringify(updated));
}

/** Permanently wipe the local vault: encrypted rows + wrapped keys + in-memory keys. Irreversible. */
export function wipeVault(): void {
  storage.removeItem(LS_KEY);
  storage.removeItem(LS_KEYS);
  clearMemory();
}

/**
 * Plaintext export of the UNLOCKED vault's live items as JSON.
 * Dangerous by design: anyone with this file has every secret in
 * readable form. Callers must get explicit user confirmation first
 * and warn strongly. Never called automatically.
 */
export function exportPlaintext(): string {
  if (!vaultKey) throw new Error('vault locked');
  return JSON.stringify(
    { format: 'my-secrect-vault-plaintext-export', format_version: 1, exported_at: new Date().toISOString(), vault_id: 'local', items: listItems() },
    null,
    2,
  );
}

export function lockVault(): void {
  clearMemory();
}

export function isUnlocked(): boolean {
  return vaultKey !== null;
}

function isDeleted(item: VaultItem): boolean {
  return item.deleted_at != null;
}

export function listItems(includeDeleted = false): VaultItem[] {
  return includeDeleted ? [...unlockedItems] : unlockedItems.filter((i) => !isDeleted(i));
}

export function listTrash(): VaultItem[] {
  return unlockedItems.filter((i) => isDeleted(i));
}

export async function upsertItem(item: VaultItem): Promise<void> {
  if (!vaultKey) throw new Error('vault locked');
  if (!item.id) throw new Error('item id must not be empty');
  // randomBytes is synchronous, so await readiness BEFORE its first use.
  await sodiumReady;
  const now = new Date().toISOString();
  const stored: VaultItem = {
    ...item,
    favorite: item.favorite ?? false,
    deleted_at: null, // an upsert is a live write: it restores a tombstoned item
    updated_at: now,
    created_at: item.created_at || now,
  };
  const itemKey = crypto.randomBytes(32);
  const wrapped = await crypto.wrapKey(vaultKey, itemKey);
  const { nonce, ciphertext } = await crypto.encrypt(
    itemKey,
    new TextEncoder().encode(JSON.stringify(stored)),
  );
  itemKey.fill(0);
  const rows = loadRows();
  const existing = rows.find((r) => r.id === stored.id);
  const row: StoredRow = {
    id: stored.id,
    revision: (existing?.revision ?? 0) + 1,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
    wrapped_item_key: toBase64(wrapped.wrapped),
    wrapped_nonce: toBase64(wrapped.nonce),
    deleted_at: null,
    base_revision: existing?.base_revision,
  };
  saveRows([...rows.filter((r) => r.id !== stored.id), row]);
  unlockedItems = [...unlockedItems.filter((i) => i.id !== stored.id), stored];
  emitMutation({ kind: 'upsert', id: stored.id });
}

/** Tombstone: keep the encrypted row, mark it deleted (trash). Restorable. */
export function deleteItem(id: string): void {
  const now = new Date().toISOString();
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (row) {
    row.deleted_at = now;
    row.revision += 1; // a delete is a local change: it must be pushed as a tombstone
    saveRows(rows);
  }
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = now;
  if (row) emitMutation({ kind: 'delete', id });
}

export function restoreItem(id: string): void {
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (row) {
    row.deleted_at = null;
    row.revision += 1; // restoring is a local change: pushed as an upsert of the kept ciphertext
    saveRows(rows);
  }
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = null;
  if (row) emitMutation({ kind: 'restore', id });
}

/**
 * "Delete forever" on this device. Purging is device-local, but the delete
 * before it is not: if the server has this item (base_revision > 0) and does
 * not have its tombstone yet — never deleted, or the delete is still unpushed —
 * the row becomes a content-free tombstone (ciphertext wiped) that the sync
 * engine pushes whenever it next runs, even if it is not running now. It is
 * removed once the server has the delete (markPushed / storeRemoteTombstone).
 */
export function permanentlyDeleteItem(id: string): void {
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  const base = row?.base_revision ?? 0;
  const serverHasTombstone = !!row?.deleted_at && row.revision <= base;
  if (row && base > 0 && !serverHasTombstone) {
    if (!row.deleted_at) {
      row.deleted_at = new Date().toISOString();
      row.revision += 1;
    }
    row.purged = true;
    row.nonce = '';
    row.ciphertext = '';
    row.wrapped_item_key = '';
    row.wrapped_nonce = '';
    saveRows(rows);
  } else {
    saveRows(rows.filter((r) => r.id !== id));
  }
  unlockedItems = unlockedItems.filter((i) => i.id !== id);
  emitMutation({ kind: 'purge', id });
}

/**
 * Flip `favorite` on an item. The in-memory flip is immediate; the
 * re-encryption is asynchronous (crypto is async) and runs fire-and-
 * forget — if it fails, the in-memory flip is reverted. Callers that
 * need durability before proceeding should `await upsertItem(...)`
 * with the flipped item instead.
 */
export function toggleFavorite(id: string): void {
  const item = unlockedItems.find((i) => i.id === id);
  if (!item) return;
  const flipped: VaultItem = { ...item, favorite: !item.favorite };
  unlockedItems = unlockedItems.map((i) => (i.id === id ? flipped : i));
  void upsertItem(flipped).catch(() => {
    unlockedItems = unlockedItems.map((i) => (i.id === id ? item : i));
  });
}

export function searchLocal(q: string): VaultItem[] {
  const s = q.trim().toLowerCase();
  if (!s) return listItems();
  // Trash is excluded: search only covers live items.
  return listItems().filter((i) =>
    (i.title + ' ' + i.tags.join(' ') + ' ' + JSON.stringify(i.fields))
      .toLowerCase()
      .includes(s),
  );
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

/** Open one export item under `key`. Throws on AEAD failure or an id mismatch.
 *  Does not write storage. The item key is zero-filled before return. */
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

/** True when local storage already holds a vault we must not overwrite. */
function vaultStorageOccupied(): boolean {
  if (storage.getItem(LS_KEYS) !== null) return true;
  const raw = storage.getItem(LS_KEY);
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return true;
    return parsed.length > 0;
  } catch {
    return true;
  }
}

/**
 * Write the wrapped envelope and rows only after every item has decrypted.
 * If the second write throws, put storage back to the values observed here.
 */
function persistRestoredVault(keys: StoredKeys, rows: StoredRow[]): void {
  const priorKeys = storage.getItem(LS_KEYS);
  const priorRows = storage.getItem(LS_KEY);
  if (priorKeys !== null || vaultStorageOccupied()) {
    throw new Error('restore: vault storage is not empty');
  }
  try {
    storage.setItem(LS_KEYS, JSON.stringify(keys));
    storage.setItem(LS_KEY, JSON.stringify(rows));
  } catch (err) {
    if (priorKeys === null) storage.removeItem(LS_KEYS);
    else storage.setItem(LS_KEYS, priorKeys);
    if (priorRows === null) storage.removeItem(LS_KEY);
    else storage.setItem(LS_KEY, priorRows);
    throw err instanceof Error ? err : new Error('restore: could not write the vault');
  }
}

/**
 * Export format_version 3. Item ciphertext stays the frozen v1 cipher
 * (encryption_version 1). The file adds the wrapped key envelope already
 * in local storage, the non-secret Argon2id metadata, and the item index
 * sealed under a key derived from the Vault Key (so the vault must be
 * unlocked). Plaintext master, vault, item, and file keys are never
 * written. Trash rows are excluded.
 */
export async function exportEncrypted(): Promise<string> {
  if (!vaultKey) throw new Error('export: vault locked');
  const keys = loadKeys();
  if (!keys) throw new Error('export: vault has no wrapped key envelope');
  const items = loadRows()
    .filter((r) => !r.deleted_at)
    .map((r) => ({
      item_id: r.id,
      revision: r.revision,
      encrypted_payload: toBase64(concat(fromBase64(r.nonce), fromBase64(r.ciphertext))),
      encrypted_item_key: toBase64(concat(fromBase64(r.wrapped_nonce), fromBase64(r.wrapped_item_key))),
      encryption_version: 1 as const,
    }));
  const itemIndex = await sealItemIndex({ vaultId: 'local', items }, vaultKey, crypto);
  return JSON.stringify(buildEncryptedExport({ vaultId: 'local', keys, items, itemIndex }));
}

/** Throws `<purpose>: …` if a v3 item list does not match its sealed index. */
async function checkItemList(data: Parameters<typeof verifyItemIndex>[0], key: Uint8Array, purpose: 'import' | 'restore'): Promise<ItemListCheck> {
  try {
    return await verifyItemIndex(data, key, crypto);
  } catch (err) {
    throw new Error(`${purpose}: ${err instanceof Error ? err.message : 'item list could not be verified'}`);
  }
}

/**
 * Merge a format_version 3 (or legacy 2) backup into an already-unlocked
 * vault. Every incoming item is decrypted with this vault's Vault Key and
 * the item list is checked against its sealed index before any write. A
 * decrypt failure, an id mismatch or an item-list mismatch throws and
 * leaves storage and the in-memory items unchanged. An equal or newer
 * local revision is left as-is only after those checks succeed.
 * Returns 'unverifiable-legacy' for a v2 file: the UI must say so.
 */
export async function importEncrypted(json: string): Promise<ItemListCheck> {
  if (!vaultKey) throw new Error('vault locked');
  const { validation, data } = parseEncryptedExportText(json);
  if (!validation.ok || !data) {
    throw new Error(`import: ${validation.errors.join(' ')}`);
  }
  const opened: Array<{ item: VaultItem; row: StoredRow }> = [];
  for (const item of data.items) {
    const decrypted = await openExportItem(vaultKey, item, 'import');
    decrypted.deleted_at = null;
    opened.push({ item: decrypted, row: rowFromExportItem(item) });
  }
  const itemList = await checkItemList(data, vaultKey, 'import');
  const nextRows = loadRows().map((row) => ({ ...row }));
  let nextItems = [...unlockedItems];
  const written: string[] = [];
  for (const { item, row } of opened) {
    const existing = nextRows.find((r) => r.id === row.id);
    if (existing && existing.revision >= row.revision) continue;
    written.push(row.id);
    if (existing?.base_revision !== undefined) row.base_revision = existing.base_revision;
    const idx = nextRows.findIndex((r) => r.id === row.id);
    if (idx >= 0) nextRows[idx] = row;
    else nextRows.push(row);
    nextItems = [...nextItems.filter((i) => i.id !== item.id), item];
  }
  saveRows(nextRows);
  unlockedItems = nextItems;
  for (const id of written) emitMutation({ kind: 'upsert', id });
  return itemList;
}

export type VaultRestoreSecret =
  | { passphrase: string; recoveryKey?: undefined }
  | { recoveryKey: string; passphrase?: undefined };

/**
 * Fresh-device restore. Storage must be empty. The backup supplies the
 * wrapped envelope; the caller supplies the passphrase (Argon2id KEK,
 * same parameters as unlock) OR the recovery key (SHA-256 of the 32-byte
 * key, not Argon2). Master and vault keys are unwrapped only in memory.
 * Every item is decrypted and its id checked, and the item list is
 * checked against its sealed index, before anything is written.
 * format_version 1, a missing envelope, a decrypt failure, an id
 * mismatch, or an item-list mismatch (a row removed, added or
 * re-versioned) throws and leaves storage unchanged. Returns
 * 'unverifiable-legacy' for a v2 file: the UI must say so.
 */
export async function restoreEncrypted(json: string, secret: VaultRestoreSecret): Promise<ItemListCheck> {
  if (isUnlocked()) throw new Error('restore: lock and wipe the vault before restoring');
  if (vaultStorageOccupied()) throw new Error('restore: vault storage is not empty');
  const { validation, data } = parseEncryptedExportText(json);
  if (!validation.ok || !data) {
    throw new Error(`restore: ${validation.errors.join(' ')}`);
  }
  const hasPassphrase = typeof secret.passphrase === 'string';
  const hasRecovery = typeof secret.recoveryKey === 'string';
  if (hasPassphrase === hasRecovery) {
    throw new Error('restore: provide a passphrase or a recovery key, not both');
  }
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
        master = await crypto.unwrapKey(
          kek,
          fromBase64(data.keys.wrapped_master_nonce),
          fromBase64(data.keys.wrapped_master),
        );
      } catch {
        throw new Error('restore: could not open the backup with this passphrase');
      } finally {
        kek.fill(0);
      }
    } else {
      const recoveryKey = (secret.recoveryKey ?? '').trim();
      let recoveryKeyBytes: Uint8Array;
      try {
        recoveryKeyBytes = fromBase64Url(recoveryKey);
      } catch {
        throw new Error('restore: recovery key must be 32 bytes');
      }
      if (recoveryKeyBytes.length !== 32) {
        recoveryKeyBytes.fill(0);
        throw new Error('restore: recovery key must be 32 bytes');
      }
      const recoveryKek = await sha256(recoveryKeyBytes);
      recoveryKeyBytes.fill(0);
      try {
        master = await crypto.unwrapKey(
          recoveryKek,
          fromBase64(data.keys.wrapped_recovery_nonce),
          fromBase64(data.keys.wrapped_recovery),
        );
      } catch {
        throw new Error('restore: could not open the backup with this recovery key');
      } finally {
        recoveryKek.fill(0);
      }
    }
    if (!master) throw new Error('restore: could not open the backup');
    try {
      vk = await crypto.unwrapKey(
        master,
        fromBase64(data.keys.wrapped_vault_nonce),
        fromBase64(data.keys.wrapped_vault),
      );
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
    const itemList = await checkItemList(data, vk, 'restore');
    persistRestoredVault(envelopeToStoredKeys(data.keys), rows);
    masterKey = master;
    vaultKey = vk;
    unlockedItems = opened;
    published = true;
    return itemList;
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

/** Counts over the unlocked in-memory items; all zero while locked. */
export function getVaultStats(): { total: number; favorites: number; trash: number } {
  const live = unlockedItems.filter((i) => !isDeleted(i));
  return {
    total: live.length,
    favorites: live.filter((i) => i.favorite).length,
    trash: unlockedItems.filter((i) => isDeleted(i)).length,
  };
}

// ---------------------------------------------------------------------------
// Sync adapter — everything packages/sync needs from the local vault.
//
// Wire format (frozen v1, same as the export format): encrypted_payload =
// base64(nonce24 || XChaCha20-Poly1305 ciphertext of the VaultItem JSON),
// encrypted_item_key = base64(nonce24 || Vault-Key-wrapped Item Key). Both
// are produced at write time by upsertItem; sync NEVER re-encrypts and
// NEVER sends a key or plaintext. A pulled row is stored with the server's
// ciphertext unchanged.
//
// Per-row bookkeeping: `revision` is the local revision counter and
// `base_revision` the last server revision synced. revision > base_revision
// = a local change waiting to be pushed.
// ---------------------------------------------------------------------------
export interface VaultMutation {
  kind: 'upsert' | 'delete' | 'restore' | 'purge';
  id: string;
}

const mutationListeners = new Set<(m: VaultMutation) => void>();

/** Subscribe to local writes (the sync layer enqueues pushes from here). */
export function onVaultMutation(listener: (m: VaultMutation) => void): () => void {
  mutationListeners.add(listener);
  return () => { mutationListeners.delete(listener); };
}

function emitMutation(m: VaultMutation): void {
  for (const listener of mutationListeners) {
    try {
      listener(m);
    } catch (err) {
      // A failing listener must never be swallowed, and must not break the
      // vault write that already succeeded: surface it as an uncaught error.
      queueMicrotask(() => { throw err; });
    }
  }
}

/** Ids of every stored row, including trash (tombstones). */
export function listRowIds(): string[] {
  return loadRows().map((r) => r.id);
}

/** Local state in the shape packages/sync expects, keyed by `keyOf(localId)`. */
export function getSyncLocalState(keyOf: (localId: string) => string): Map<string, LocalItemState> {
  const out = new Map<string, LocalItemState>();
  const byId = new Map(unlockedItems.map((i) => [i.id, i] as const));
  for (const row of loadRows()) {
    const item = byId.get(row.id);
    if (!item) continue;
    out.set(keyOf(row.id), { item, revision: row.revision, baseRevision: row.base_revision ?? 0 });
  }
  return out;
}

export type SyncPushDraft = Omit<PushRequest, 'vault_id'> & { local_revision: number };

/**
 * The push for a locally changed row, or null when there is nothing to push
 * (row gone, already synced, or a delete of an item the server never saw).
 * `wireId` is the server-side item id. Ciphertext is copied from the row.
 */
export function buildSyncPush(id: string, wireId: string): SyncPushDraft | null {
  const row = loadRows().find((r) => r.id === id);
  if (!row) return null;
  const base = row.base_revision ?? 0;
  if (row.revision <= base) return null;
  if (row.deleted_at) {
    if (base === 0) return null; // never reached the server: nothing to tombstone there
    return { item_id: wireId, base_revision: base, encrypted_payload: '', encrypted_item_key: '', encryption_version: 1, operation: 'delete', local_revision: row.revision };
  }
  return {
    item_id: wireId,
    base_revision: base,
    encrypted_payload: toBase64(concat(fromBase64(row.nonce), fromBase64(row.ciphertext))),
    encrypted_item_key: toBase64(concat(fromBase64(row.wrapped_nonce), fromBase64(row.wrapped_item_key))),
    encryption_version: 1,
    operation: 'upsert',
    local_revision: row.revision,
  };
}

/** The server accepted a push at `serverRevision`. Returns 'dirty' when the
 *  row was edited again after the pushed version was built. */
export function markPushed(id: string, serverRevision: number, pushedLocalRevision: number): 'clean' | 'dirty' | 'gone' {
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return 'gone';
  row.base_revision = serverRevision;
  let state: 'clean' | 'dirty' = 'clean';
  if (row.revision === pushedLocalRevision) {
    row.revision = serverRevision;
  } else {
    row.revision = Math.max(row.revision, serverRevision + 1);
    state = 'dirty';
  }
  // A purged row's tombstone is now on the server: nothing of it is kept.
  saveRows(row.purged && state === 'clean' ? rows.filter((r) => r.id !== id) : rows);
  return state;
}

/**
 * Decrypt + AEAD-verify one pulled event with the in-memory Vault Key.
 * Throws on any failure (wrong key, tampered bytes, unsupported
 * encryption_version, malformed JSON); the caller reports it. Writes nothing.
 */
export async function decryptSyncEvent(event: SyncEvent): Promise<VaultItem> {
  if (!vaultKey) throw new Error('vault locked');
  if (event.encryption_version !== 1) {
    throw new Error(`unsupported encryption_version ${String(event.encryption_version)}`);
  }
  if (!event.encrypted_payload || !event.encrypted_item_key) throw new Error('event has no ciphertext');
  const payload = splitNoncePrefixed(event.encrypted_payload);
  const wrapped = splitNoncePrefixed(event.encrypted_item_key);
  let itemKey: Uint8Array | null = null;
  try {
    itemKey = await crypto.unwrapKey(vaultKey, wrapped.nonce, wrapped.rest);
    const plaintext = await crypto.decrypt(itemKey, payload.nonce, payload.rest);
    const item = JSON.parse(new TextDecoder().decode(plaintext)) as VaultItem;
    if (typeof item !== 'object' || item === null || typeof item.id !== 'string') {
      throw new Error('decrypted payload is not a vault item');
    }
    return item;
  } finally {
    itemKey?.fill(0);
  }
}

/** Store a remote item (already verified by decryptSyncEvent) with the
 *  server's ciphertext unchanged, as synced at `revision`. */
export function storeRemoteItem(item: VaultItem, revision: number, event: SyncEvent): void {
  if (!vaultKey) throw new Error('vault locked');
  if (!event.encrypted_payload || !event.encrypted_item_key) throw new Error('event has no ciphertext');
  const payload = splitNoncePrefixed(event.encrypted_payload);
  const wrapped = splitNoncePrefixed(event.encrypted_item_key);
  const live: VaultItem = { ...item, deleted_at: null };
  const row: StoredRow = {
    id: live.id,
    revision,
    base_revision: revision,
    nonce: toBase64(payload.nonce),
    ciphertext: toBase64(payload.rest),
    wrapped_item_key: toBase64(wrapped.rest),
    wrapped_nonce: toBase64(wrapped.nonce),
    deleted_at: null,
  };
  const rows = loadRows();
  saveRows([...rows.filter((r) => r.id !== live.id), row]);
  unlockedItems = [...unlockedItems.filter((i) => i.id !== live.id), live];
}

/** A remote delete: move the item to trash (restorable), synced at `revision`. */
export function storeRemoteTombstone(id: string, revision: number): void {
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  if (row.purged) {
    // Deleted forever here and now deleted on the server too: drop the tombstone row.
    saveRows(rows.filter((r) => r.id !== id));
    return;
  }
  row.deleted_at = new Date().toISOString();
  row.base_revision = revision;
  row.revision = revision;
  saveRows(rows);
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = row.deleted_at;
}

/**
 * After the user resolved a conflict: re-base the local row on the remote
 * revision it conflicted with and mark it as a pending change, so the next
 * push (base = remoteRevision) is accepted by the server. The local content
 * is unchanged — nothing is discarded.
 */
export function rebaseForPush(id: string, remoteRevision: number): void {
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error('rebase: item not found locally');
  const base = Math.max(row.base_revision ?? 0, remoteRevision);
  row.base_revision = base;
  row.revision = Math.max(row.revision, base + 1);
  saveRows(rows);
  emitMutation({ kind: 'upsert', id });
}
