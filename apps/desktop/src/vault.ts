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

const storage: StorageBackend = new LocalStorageBackend();

/** One encrypted row. Nonce and ciphertext are stored as separate base64 fields. */
interface StoredRow {
  id: string;
  revision: number;
  nonce: string; // base64, 24 bytes
  ciphertext: string; // base64, plaintext + 16-byte Poly1305 tag
  wrapped_item_key: string; // base64, Vault-Key-wrapped Item Key (ciphertext only)
  wrapped_nonce: string; // base64, 24 bytes
  deleted_at?: string | null; // tombstone; null/undefined = live
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

/** Export format v1. Built from stored rows only — never from plaintext. */
export interface VaultExport {
  format: 'my-secrect-vault-export';
  format_version: 1;
  exported_at: string;
  vault_id: 'local';
  items: Array<{
    item_id: string;
    revision: number;
    encrypted_payload: string; // base64: nonce (24B) || ciphertext+tag (16B)
    encrypted_item_key: string; // base64: wrapped nonce (24B) || wrapped key
    encryption_version: number; // 1
  }>;
  relations_included: true;
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

/** Decrypt every row with the in-memory Vault Key. Throws on any bad row. */
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
    // Tombstone state lives on the row (metadata), not in the payload.
    if (row.deleted_at) item.deleted_at = row.deleted_at;
    items.push(item);
    itemKey.fill(0);
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
  };
  saveRows([...rows.filter((r) => r.id !== stored.id), row]);
  unlockedItems = [...unlockedItems.filter((i) => i.id !== stored.id), stored];
}

/** Tombstone: keep the encrypted row, mark it deleted (trash). Restorable. */
export function deleteItem(id: string): void {
  const now = new Date().toISOString();
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (row) {
    row.deleted_at = now;
    saveRows(rows);
  }
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = now;
}

export function restoreItem(id: string): void {
  const rows = loadRows();
  const row = rows.find((r) => r.id === id);
  if (row) {
    row.deleted_at = null;
    saveRows(rows);
  }
  const item = unlockedItems.find((i) => i.id === id);
  if (item) item.deleted_at = null;
}

export function permanentlyDeleteItem(id: string): void {
  saveRows(loadRows().filter((r) => r.id !== id));
  unlockedItems = unlockedItems.filter((i) => i.id !== id);
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

/**
 * Export the vault as JSON v1, built from STORED ROWS only — no plaintext
 * is read. Trash rows are excluded. Each row becomes
 * `nonce (24B) || ciphertext` and `wrapped nonce (24B) || wrapped key`,
 * both base64, so import can split the nonce back off.
 */
export function exportEncrypted(): string {
  const items = loadRows()
    .filter((r) => !r.deleted_at)
    .map((r) => ({
      item_id: r.id,
      revision: r.revision,
      encrypted_payload: toBase64(concat(fromBase64(r.nonce), fromBase64(r.ciphertext))),
      encrypted_item_key: toBase64(concat(fromBase64(r.wrapped_nonce), fromBase64(r.wrapped_item_key))),
      encryption_version: 1,
    }));
  const out: VaultExport = {
    format: 'my-secrect-vault-export',
    format_version: 1,
    exported_at: new Date().toISOString(),
    vault_id: 'local',
    items,
    relations_included: true,
  };
  return JSON.stringify(out);
}

/**
 * Import a VaultExport v1 JSON string. Requires an unlocked vault
 * (imported rows must be openable with this vault's Vault Key).
 * Rows merge by id, keeping the higher revision; rows this vault cannot
 * decrypt are skipped. Throws Error on malformed JSON or a bad
 * format / format_version.
 */
export async function importEncrypted(json: string): Promise<void> {
  if (!vaultKey) throw new Error('vault locked');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('import: invalid JSON');
  }
  const data = parsed as Partial<VaultExport>;
  if (data.format !== 'my-secrect-vault-export' || data.format_version !== 1 || !Array.isArray(data.items)) {
    throw new Error('import: unsupported vault export format');
  }
  const rows = loadRows();
  for (const item of data.items) {
    if (
      typeof item.item_id !== 'string' || !item.item_id ||
      typeof item.revision !== 'number' ||
      typeof item.encrypted_payload !== 'string' ||
      typeof item.encrypted_item_key !== 'string'
    ) {
      throw new Error('import: malformed item in export');
    }
    const existing = rows.find((r) => r.id === item.item_id);
    if (existing && existing.revision >= item.revision) continue;
    // Verify this vault can open the row before storing it.
    let decrypted: VaultItem;
    try {
      const payload = splitNoncePrefixed(item.encrypted_payload);
      const wrapped = splitNoncePrefixed(item.encrypted_item_key);
      const itemKey = await crypto.unwrapKey(vaultKey, wrapped.nonce, wrapped.rest);
      const plaintext = await crypto.decrypt(itemKey, payload.nonce, payload.rest);
      itemKey.fill(0);
      decrypted = JSON.parse(new TextDecoder().decode(plaintext)) as VaultItem;
      if (decrypted.id !== item.item_id) continue;
    } catch {
      continue; // undecryptable under this vault key: skip the row
    }
    const row: StoredRow = {
      id: item.item_id,
      revision: item.revision,
      nonce: toBase64(splitNoncePrefixed(item.encrypted_payload).nonce),
      ciphertext: toBase64(splitNoncePrefixed(item.encrypted_payload).rest),
      wrapped_item_key: toBase64(splitNoncePrefixed(item.encrypted_item_key).rest),
      wrapped_nonce: toBase64(splitNoncePrefixed(item.encrypted_item_key).nonce),
      deleted_at: null,
    };
    const idx = rows.findIndex((r) => r.id === item.item_id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    decrypted.deleted_at = null;
    unlockedItems = [...unlockedItems.filter((i) => i.id !== decrypted.id), decrypted];
  }
  saveRows(rows);
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
