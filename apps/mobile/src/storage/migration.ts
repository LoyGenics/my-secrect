/**
 * One-time move of an AsyncStorage-build vault into vault.db
 * (specs/mobile-local-store.md §2 "Migration from AsyncStorage").
 *
 * Copy both keys in one transaction, verify the row count, and only then
 * delete the AsyncStorage keys. Anything unreadable (bad JSON, a row
 * missing a field) aborts before the copy: AsyncStorage stays untouched,
 * the error reaches the lock screen, and no row is ever dropped.
 */
import type { StoredKeys, StoredRow, VaultStore } from './vaultStore';

export const LEGACY_ROWS_KEY = 'my-secrect.local-vault.v1';
export const LEGACY_KEYS_KEY = 'my-secrect.local-vault.v1.keys';

export interface LegacyKeyValueStore {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

export type MigrationResult = { migrated: false } | { migrated: true; rows: number };

const KEY_FIELDS: Array<keyof StoredKeys> = [
  'salt', 'wrapped_master', 'wrapped_master_nonce', 'wrapped_vault', 'wrapped_vault_nonce',
  'wrapped_recovery', 'wrapped_recovery_nonce',
];
const ROW_TEXT_FIELDS = ['id', 'nonce', 'ciphertext', 'wrapped_item_key', 'wrapped_nonce'] as const;

function parseKeys(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('migration: the stored key envelope is not valid JSON'); }
  const o = parsed as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || KEY_FIELDS.some((f) => typeof o[f] !== 'string')) {
    throw new Error('migration: the stored key envelope is missing fields');
  }
  return raw; // stored verbatim: "StoredKeys JSON, unchanged"
}

function parseRows(raw: string): StoredRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('migration: the stored item rows are not valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('migration: the stored item rows are not a list');
  const ids = new Set<string>();
  return parsed.map((value, i) => {
    const r = value as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null) throw new Error(`migration: row ${i} is not an object`);
    for (const f of ROW_TEXT_FIELDS) if (typeof r[f] !== 'string') throw new Error(`migration: row ${i} has no ${f}`);
    if (!Number.isInteger(r.revision)) throw new Error(`migration: row ${i} has no integer revision`);
    const del = r.deleted_at;
    if (del !== undefined && del !== null && typeof del !== 'string') throw new Error(`migration: row ${i} has a bad deleted_at`);
    const id = r.id as string;
    if (ids.has(id)) throw new Error(`migration: row id ${id} appears twice`);
    ids.add(id);
    return {
      id, revision: r.revision as number, nonce: r.nonce as string, ciphertext: r.ciphertext as string,
      wrapped_item_key: r.wrapped_item_key as string, wrapped_nonce: r.wrapped_nonce as string,
      deleted_at: (del as string | null | undefined) ?? null,
    };
  });
}

export async function migrateFromAsyncStorage(store: VaultStore, legacy: LegacyKeyValueStore): Promise<MigrationResult> {
  const rawKeys = await legacy.getItem(LEGACY_KEYS_KEY);
  const rawRows = await legacy.getItem(LEGACY_ROWS_KEY);
  if (rawKeys === null && rawRows === null) return { migrated: false };
  const keysJson = rawKeys === null ? null : parseKeys(rawKeys);
  const rows = rawRows === null ? [] : parseRows(rawRows);
  await store.importLegacy(keysJson, rows);
  // Read back after COMMIT, before anything is deleted.
  if ((await store.countRows()) < rows.length) throw new Error('migration: vault.db is missing rows after the copy');
  if (keysJson !== null && (await store.getKeysJson()) !== keysJson) throw new Error('migration: vault.db key envelope does not match after the copy');
  await legacy.removeItem(LEGACY_ROWS_KEY);
  await legacy.removeItem(LEGACY_KEYS_KEY);
  return { migrated: true, rows: rows.length };
}
