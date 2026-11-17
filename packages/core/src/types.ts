/**
 * Universal Vault Item Model — plaintext form on the CLIENT, BEFORE encryption.
 * The server NEVER sees this. It only sees EncryptedItem (see below).
 * Relations are also encrypted: the server must not infer a user's life/work graph.
 */
export type ItemType =
  | 'login' | 'passkey' | 'bank_account' | 'card' | 'identity'
  | 'ssh_key' | 'api_key' | 'secure_note' | 'document' | 'media'
  | 'collection' | 'custom';

// Schema versioning (Phase C — see packages/schemas/README.md for the rules).
// v1 is the only supported version. Unknown versions must be REJECTED by
// clients, never silently accepted or guessed at.
export const CURRENT_SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export function isSupportedSchemaVersion(version: unknown): version is 1 {
  return version === 1;
}

/** Validate an item's schema version. Returns an error string, or null if OK. */
export function validateItemVersion(item: { schema_version?: unknown }): string | null {
  if (!isSupportedSchemaVersion(item.schema_version)) {
    return `unsupported schema_version '${String(item.schema_version)}' (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`;
  }
  return null;
}

export interface VaultRelation { type: string; target_id: string; }

export interface VaultItem {
  id: string; // e.g. item_01 — opaque, client-generated (CSPRNG)
  type: ItemType;
  schema_version: number; // 1
  title: string;
  fields: Record<string, unknown>; // type-specific, validated by packages/schemas
  tags: string[];
  relations: VaultRelation[];
  attachments: string[]; // blob ids
  favorite?: boolean; // starred by the user; defaults to false when absent
  deleted_at?: string | null; // ISO 8601 when tombstoned (trash); null/undefined = live
  created_at: string; // ISO 8601
  updated_at: string;
}

/** What Rails / Postgres actually stores. No plaintext title, tags, type or relations. */
export interface EncryptedItem {
  id: string;
  vault_id: string;
  current_revision: number;
  deleted_at: string | null;
}

export interface EncryptedItemVersion {
  item_id: string;
  revision: number;
  encrypted_payload: string; // base64: nonce + XChaCha20-Poly1305 ciphertext of VaultItem JSON
  encrypted_item_key: string; // base64: Vault-Key-wrapped Item Key
  encryption_version: number; // 1
}

export interface EncryptedTombstone { item_id: string; revision: number; deleted_at: string; }

export const BANK_ACCOUNT_EXAMPLE: VaultItem = {
  id: 'item_01', type: 'bank_account', schema_version: 1,
  title: 'My Main Bank',
  fields: { bank_name: 'Example Bank', account_number: '0123456789', currency: 'VND', holder_name: 'Example Person' },
  tags: ['personal', 'finance'],
  relations: [
    { type: 'has_login', target_id: 'item_02' },
    { type: 'has_card', target_id: 'item_03' },
  ],
  attachments: ['file_01'],
  created_at: '2026-11-17T00:00:00.000Z', updated_at: '2026-11-17T00:00:00.000Z',
};
