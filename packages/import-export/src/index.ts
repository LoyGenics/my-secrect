/**
 * Import / export — portable formats, validation, and CSV import.
 *
 * This package does no I/O and no storage, and has no crypto dependency:
 * it validates shapes, versions and base64, and parses other password
 * managers' CSV exports into drafts. The one crypto step it owns — sealing
 * and verifying the backup's item index — runs through the caller's
 * adapter (`ItemIndexCrypto`). Decryption / encryption of the rows lives
 * in the vault implementations (apps/desktop/src/vault.ts,
 * apps/mobile/src/vault.ts, apps/extension/src/lib/vault-ext.ts).
 * Those vaults abort the whole import or restore when a row fails;
 * they never skip a bad row and never write a partial file.
 *
 * Formats (all JSON, versioned):
 *  - Encrypted vault export: format 'my-secrect-vault-export',
 *    format_version 3 (writer) or 2 (legacy, still restores). v3 adds
 *    `item_index`: the item list (ids + revisions + count, bound to the
 *    format, version and vault_id) sealed with XChaCha20-Poly1305 under
 *    HKDF-SHA-256(Vault Key, ITEM_INDEX_HKDF_INFO). A removed, added or
 *    re-versioned row no longer matches it and the restore/import fails
 *    closed. v2 has no index: it restores, but the caller must tell the
 *    user the item list could not be verified.
 *    Items still use the frozen v1 item cipher:
 *    encryption_version 1, XChaCha20-Poly1305 IETF, 24-byte nonce,
 *    null additional data. `encrypted_payload` is base64(nonce24 ||
 *    ciphertext||tag) and `encrypted_item_key` is base64(wrap_nonce24
 *    || wrapped||tag). The file ALSO carries the wrapped key envelope
 *    already stored locally (salt, wrapped_master, wrapped_vault,
 *    wrapped_recovery, and their nonces) plus non-secret KDF metadata.
 *    It never contains a plaintext master, vault, item, or file key.
 *    Trash rows are never exported. A plaintext export is a DIFFERENT
 *    format ('my-secrect-vault-plaintext-export') and is NEVER accepted
 *    by the encrypted-import path — the two must never be confused.
 *  - Plaintext export: format_version 1, items are VaultItem plaintext.
 *    Desktop-only, behind an explicit warning + confirm checkbox.
 *    The web client offers encrypted-only export.
 *
 * Version policy: encrypted format_version 3 is written; 3 and 2 are
 * accepted. format_version 1 has items and no key envelope,
 * so a fresh device cannot restore it — it is rejected, not skipped.
 * A newer version is REJECTED ("created by a newer version — update
 * the app"), never silently imported. Tampered structure is rejected
 * here, before decrypt. A row that fails AEAD or whose decrypted id
 * does not match item_id aborts the vault import with no writes; so
 * does a v3 item list that does not match its sealed index.
 */

/** Encrypted backup format written today (authenticated item index). Item ciphertext stays encryption_version 1. */
export const ENCRYPTED_EXPORT_FORMAT_VERSION = 3;
/** Oldest encrypted format that still restores: no item index, so a dropped row cannot be detected. */
export const LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION = 2;
/** HKDF-SHA-256 `info` for the key that seals the item index (IKM = Vault Key, salt = 32 zero bytes). */
export const ITEM_INDEX_HKDF_INFO = 'my-secrect/backup-item-index/v1';
/** Plaintext export is a separate format and stays at version 1. */
export const PLAINTEXT_EXPORT_FORMAT_VERSION = 1;
/** @see ENCRYPTED_EXPORT_FORMAT_VERSION */
export const EXPORT_FORMAT_VERSION = ENCRYPTED_EXPORT_FORMAT_VERSION;
export const ENCRYPTED_EXPORT_FORMAT = 'my-secrect-vault-export';
export const PLAINTEXT_EXPORT_FORMAT = 'my-secrect-vault-plaintext-export';
/** Hard cap on rows in one import file — a larger file is rejected, not truncated. */
export const MAX_IMPORT_ITEMS = 10_000;
/** Max validation errors listed before the rest are summarised as a count. */
const MAX_LISTED_ERRORS = 10;

const SALT_BYTES = 16;
const NONCE_BYTES = 24;
/** 32-byte key plus the 16-byte Poly1305 tag from XChaCha20-Poly1305 IETF. */
const WRAPPED_KEY_BYTES = 48;
const ITEM_KEY_BLOB_BYTES = NONCE_BYTES + WRAPPED_KEY_BYTES;
const MIN_PAYLOAD_BYTES = NONCE_BYTES + 16;

/**
 * Non-secret description of the frozen KDF. Vault code does not read
 * these numbers to choose a cipher: deriveKek stays Argon2id
 * INTERACTIVE (opslimit 2, memlimit 67108864, 16-byte salt, 32-byte
 * output, UTF-8 passphrase) and the recovery KEK stays SHA-256 of the
 * 32-byte recovery key. A file whose metadata disagrees is rejected.
 */
export const EXPORT_KDF_METADATA = {
  name: 'argon2id',
  opslimit: 2,
  memlimit: 67108864,
  salt_bytes: SALT_BYTES,
  output_bytes: 32,
  recovery_kek: 'sha256',
  cipher: 'xchacha20poly1305-ietf',
  nonce_bytes: NONCE_BYTES,
  encryption_version: 1,
} as const;

export interface WrappedKeyEnvelope {
  salt: string;
  wrapped_master: string;
  wrapped_master_nonce: string;
  wrapped_vault: string;
  wrapped_vault_nonce: string;
  wrapped_recovery: string;
  wrapped_recovery_nonce: string;
}

export interface EncryptedExportItem {
  item_id: string;
  revision: number;
  encrypted_payload: string;
  encrypted_item_key: string;
  encryption_version: number;
}

/** The item index sealed under the index key (see ITEM_INDEX_HKDF_INFO). */
export interface SealedItemIndex {
  /** base64, 24 bytes */
  nonce: string;
  /** base64(XChaCha20-Poly1305 ciphertext || tag) of `itemIndexBytes(...)` */
  sealed: string;
}

export interface VaultExport {
  format: 'my-secrect-vault-export';
  format_version: typeof ENCRYPTED_EXPORT_FORMAT_VERSION | typeof LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION;
  exported_at: string;
  vault_id: string;
  kdf: { [K in keyof typeof EXPORT_KDF_METADATA]: (typeof EXPORT_KDF_METADATA)[K] };
  keys: WrappedKeyEnvelope;
  items: EncryptedExportItem[];
  relations_included: true;
  /** Present (and required) in format_version 3. */
  item_index?: SealedItemIndex;
}

const ENVELOPE_FIELD_BYTES: Record<keyof WrappedKeyEnvelope, number> = {
  salt: SALT_BYTES,
  wrapped_master: WRAPPED_KEY_BYTES,
  wrapped_master_nonce: NONCE_BYTES,
  wrapped_vault: WRAPPED_KEY_BYTES,
  wrapped_vault_nonce: NONCE_BYTES,
  wrapped_recovery: WRAPPED_KEY_BYTES,
  wrapped_recovery_nonce: NONCE_BYTES,
};

/**
 * Copy only the wrapped envelope. Callers must not pass plaintext keys.
 * With `itemIndex` (from `sealItemIndex` over the SAME vaultId and items)
 * this writes format_version 3; without it, the legacy format_version 2,
 * whose item list cannot be verified on restore.
 */
export function buildEncryptedExport(input: {
  vaultId: string;
  exportedAt?: string;
  keys: WrappedKeyEnvelope;
  items: EncryptedExportItem[];
  itemIndex?: SealedItemIndex;
}): VaultExport {
  const source = input.keys;
  return {
    format: ENCRYPTED_EXPORT_FORMAT,
    format_version: input.itemIndex ? ENCRYPTED_EXPORT_FORMAT_VERSION : LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION,
    exported_at: input.exportedAt ?? new Date().toISOString(),
    vault_id: input.vaultId,
    kdf: { ...EXPORT_KDF_METADATA },
    keys: {
      salt: source.salt,
      wrapped_master: source.wrapped_master,
      wrapped_master_nonce: source.wrapped_master_nonce,
      wrapped_vault: source.wrapped_vault,
      wrapped_vault_nonce: source.wrapped_vault_nonce,
      wrapped_recovery: source.wrapped_recovery,
      wrapped_recovery_nonce: source.wrapped_recovery_nonce,
    },
    items: input.items,
    relations_included: true,
    ...(input.itemIndex ? { item_index: { nonce: input.itemIndex.nonce, sealed: input.itemIndex.sealed } } : {}),
  };
}

export function buildExportSkeleton(vaultId: string, keys: WrappedKeyEnvelope): VaultExport {
  return buildEncryptedExport({ vaultId, keys, items: [] });
}

// ---------------------------------------------------------------------------
// Authenticated item index (format_version 3)
// ---------------------------------------------------------------------------

/** The subset of the vault's crypto adapter the index needs (libsodiumAdapter fits). */
export interface ItemIndexCrypto {
  hkdf(ikm: Uint8Array, info: string, length?: number): Promise<Uint8Array>;
  encrypt(key: Uint8Array, plaintext: Uint8Array): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;
  decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** 'unverifiable-legacy' = a format_version 2 backup: restored, but a dropped item could not be detected. */
export type ItemListCheck = 'verified' | 'unverifiable-legacy';

/** Stable text of a failed index check (UIs match on it). */
export const ITEM_INDEX_MISMATCH = 'item list does not match its authenticated index';

const utf8 = new TextEncoder();

function wellFormedUtf8(s: string, what: string): Uint8Array {
  const bytes = utf8.encode(s);
  // TextEncoder maps a lone surrogate to U+FFFD, which would make two
  // different ids encode alike; refuse instead of guessing.
  if (new TextDecoder().decode(bytes) !== s) throw new Error(`${what} is not well-formed Unicode`);
  return bytes;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Canonical bytes of the item list (big-endian, every string
 * length-prefixed, so the encoding is injective):
 *
 *   u32(len(format)) || format || u32(format_version)
 *   || u32(len(vault_id)) || vault_id || u32(count)
 *   || for each item, sorted by the UTF-8 bytes of item_id:
 *        u32(len(item_id)) || item_id || u64(revision)
 *
 * Order of rows in the file does not matter; their set does.
 */
export function itemIndexBytes(doc: {
  format_version: number;
  vault_id: string;
  items: ReadonlyArray<{ item_id: string; revision: number }>;
}): Uint8Array {
  const format = utf8.encode(ENCRYPTED_EXPORT_FORMAT);
  const vaultId = wellFormedUtf8(doc.vault_id, 'vault_id');
  const rows = doc.items
    .map((it) => {
      if (!Number.isSafeInteger(it.revision) || it.revision < 0) {
        throw new Error(`item ${it.item_id}: revision must be an integer in 0..2^53-1`);
      }
      return { id: wellFormedUtf8(it.item_id, 'item_id'), revision: it.revision };
    })
    .sort((a, b) => compareBytes(a.id, b.id));
  let size = 4 + format.length + 4 + 4 + vaultId.length + 4;
  for (const r of rows) size += 4 + r.id.length + 8;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const putBytes = (b: Uint8Array) => {
    view.setUint32(at, b.length);
    out.set(b, at + 4);
    at += 4 + b.length;
  };
  putBytes(format);
  view.setUint32(at, doc.format_version);
  at += 4;
  putBytes(vaultId);
  view.setUint32(at, rows.length);
  at += 4;
  for (const r of rows) {
    putBytes(r.id);
    // u64 big-endian without BigInt (revision <= 2^53-1).
    view.setUint32(at, Math.floor(r.revision / 0x1_0000_0000));
    view.setUint32(at + 4, r.revision >>> 0);
    at += 8;
  }
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Seal the index of the rows about to be exported (format_version 3). The derived key is zero-filled. */
export async function sealItemIndex(
  input: { vaultId: string; items: ReadonlyArray<{ item_id: string; revision: number }> },
  vaultKey: Uint8Array,
  crypto: ItemIndexCrypto,
): Promise<SealedItemIndex> {
  const plaintext = itemIndexBytes({ format_version: ENCRYPTED_EXPORT_FORMAT_VERSION, vault_id: input.vaultId, items: input.items });
  const key = await crypto.hkdf(vaultKey, ITEM_INDEX_HKDF_INFO, 32);
  try {
    const { nonce, ciphertext } = await crypto.encrypt(key, plaintext);
    return { nonce: toB64(nonce), sealed: toB64(ciphertext) };
  } finally {
    key.fill(0);
  }
}

/**
 * Check a VALIDATED export's item list against its sealed index, with the
 * Vault Key the rows were opened with. format_version 2 has no index and
 * returns 'unverifiable-legacy' (the caller must say so to the user). A v3
 * index that does not open, or whose list differs from the file's rows in
 * any id, revision or count, throws — nothing may be written then.
 */
export async function verifyItemIndex(doc: VaultExport, vaultKey: Uint8Array, crypto: ItemIndexCrypto): Promise<ItemListCheck> {
  if (doc.format_version === LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION) return 'unverifiable-legacy';
  const mismatch = `${ITEM_INDEX_MISMATCH} (an item was removed, added, or its revision changed)`;
  if (doc.format_version !== ENCRYPTED_EXPORT_FORMAT_VERSION || !doc.item_index) throw new Error(mismatch);
  const expected = itemIndexBytes(doc);
  const key = await crypto.hkdf(vaultKey, ITEM_INDEX_HKDF_INFO, 32);
  let opened: Uint8Array;
  try {
    opened = await crypto.decrypt(key, fromB64(doc.item_index.nonce), fromB64(doc.item_index.sealed));
  } catch {
    throw new Error(mismatch);
  } finally {
    key.fill(0);
  }
  if (compareBytes(opened, expected) !== 0) throw new Error(mismatch);
  return 'verified';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ImportValidation {
  /** True only when the file is safe to hand to the vault import. */
  ok: boolean;
  /** Human-readable, safe errors (never echo secret content). */
  errors: string[];
  /** Non-fatal notes, e.g. duplicate ids resolved by highest revision. */
  warnings: string[];
  formatVersion?: number;
  itemCount: number;
  /** Ids that appear more than once in the file. */
  duplicateIds: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBase64(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    return atob(s).length > 0;
  } catch {
    return false;
  }
}

function base64ByteLength(s: string): number {
  try {
    return atob(s).length;
  } catch {
    return -1;
  }
}

function pushError(list: string[], msg: string): void {
  if (list.length < MAX_LISTED_ERRORS) list.push(msg);
}

function reject(errors: string[], warnings: string[], duplicateIds: string[], formatVersion?: number, itemCount = 0): ImportValidation {
  return { ok: false, errors, warnings, formatVersion, itemCount, duplicateIds };
}

/**
 * Validate a parsed JSON value as an encrypted vault export (v3, or legacy v2).
 * Structural problems, including a missing envelope, KDF metadata
 * that does not match the frozen contract, or a v3 file without its
 * item index, fail here — before decrypt. Whether the index MATCHES is
 * checked by `verifyItemIndex` once the Vault Key is known.
 */
export function validateEncryptedExport(data: unknown): ImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const duplicateIds: string[] = [];
  if (!isRecord(data)) return reject(['Import file is not a JSON object.'], warnings, duplicateIds);
  if (data.format === PLAINTEXT_EXPORT_FORMAT) {
    return reject(['This is a plaintext export. Plaintext files cannot be imported as an encrypted backup — use a desktop encrypted backup instead.'], warnings, duplicateIds);
  }
  if (data.format !== ENCRYPTED_EXPORT_FORMAT) {
    return reject(['Not a my-secrect vault export (unexpected "format" field).'], warnings, duplicateIds);
  }
  const version = data.format_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return reject(['Export is missing a valid "format_version".'], warnings, duplicateIds);
  }
  if (version > ENCRYPTED_EXPORT_FORMAT_VERSION) {
    return reject([`Export was created by a newer version (format_version ${version}). Update this app before importing it.`], warnings, duplicateIds, version);
  }
  if (version === 1) {
    return reject(['format_version 1 backups contain items only and have no wrapped key envelope. A new device cannot restore them. Export a format_version 2 backup.'], warnings, duplicateIds, version);
  }
  if (version !== ENCRYPTED_EXPORT_FORMAT_VERSION && version !== LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION) {
    return reject([`Unsupported export version (format_version ${version}). Only versions ${LEGACY_ENCRYPTED_EXPORT_FORMAT_VERSION} and ${ENCRYPTED_EXPORT_FORMAT_VERSION} can be imported.`], warnings, duplicateIds, version);
  }
  if (version === ENCRYPTED_EXPORT_FORMAT_VERSION) {
    const index = data.item_index;
    if (!isRecord(index)) {
      pushError(errors, 'Export is missing its authenticated item index ("item_index").');
    } else if (
      typeof index.nonce !== 'string' || !isBase64(index.nonce) || base64ByteLength(index.nonce) !== NONCE_BYTES
      || typeof index.sealed !== 'string' || !isBase64(index.sealed) || base64ByteLength(index.sealed) <= 16
    ) {
      pushError(errors, 'Export "item_index" is malformed.');
    }
  }
  if (typeof data.exported_at !== 'string' || data.exported_at === '') {
    pushError(errors, 'Export is missing "exported_at".');
  } else if (Number.isNaN(Date.parse(data.exported_at))) {
    warnings.push('"exported_at" is not a valid date; continuing anyway.');
  }
  if (typeof data.vault_id !== 'string' || data.vault_id === '') {
    pushError(errors, 'Export is missing "vault_id".');
  }
  if (data.relations_included !== true) {
    pushError(errors, 'Export "relations_included" must be true.');
  }
  if (!isRecord(data.kdf)) {
    pushError(errors, 'Export is missing the "kdf" metadata object.');
  } else {
    for (const key of Object.keys(EXPORT_KDF_METADATA) as Array<keyof typeof EXPORT_KDF_METADATA>) {
      if (data.kdf[key] !== EXPORT_KDF_METADATA[key]) {
        pushError(errors, `Export "kdf.${key}" does not match the frozen contract.`);
      }
    }
  }
  if (!isRecord(data.keys)) {
    pushError(errors, 'Export is missing the wrapped key envelope ("keys").');
  } else {
    for (const field of Object.keys(ENVELOPE_FIELD_BYTES) as Array<keyof WrappedKeyEnvelope>) {
      const value = data.keys[field];
      if (typeof value !== 'string' || !isBase64(value) || base64ByteLength(value) !== ENVELOPE_FIELD_BYTES[field]) {
        pushError(errors, `Export key envelope field "${field}" is missing or the wrong length.`);
      }
    }
  }
  if (!Array.isArray(data.items)) {
    pushError(errors, 'Export has no "items" array.');
    return reject(errors, warnings, duplicateIds, version);
  }
  if (data.items.length > MAX_IMPORT_ITEMS) {
    pushError(errors, `Export has ${data.items.length} items, over the limit of ${MAX_IMPORT_ITEMS}. Split the file and import it in parts.`);
    return reject(errors, warnings, duplicateIds, version, data.items.length);
  }
  const seen = new Set<string>();
  data.items.forEach((raw, i) => {
    const at = `item ${i + 1}`;
    if (!isRecord(raw)) { pushError(errors, `${at}: not an object.`); return; }
    if (typeof raw.item_id !== 'string' || raw.item_id === '') { pushError(errors, `${at}: missing "item_id".`); return; }
    if (seen.has(raw.item_id)) {
      if (!duplicateIds.includes(raw.item_id)) duplicateIds.push(raw.item_id);
      pushError(errors, `${at} (${raw.item_id}): duplicate "item_id".`);
    } else seen.add(raw.item_id);
    if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0) {
      pushError(errors, `${at} (${raw.item_id}): "revision" must be a non-negative integer.`);
    } else if (version === ENCRYPTED_EXPORT_FORMAT_VERSION && !Number.isSafeInteger(raw.revision)) {
      pushError(errors, `${at} (${raw.item_id}): "revision" is larger than 2^53-1.`);
    }
    if (typeof raw.encrypted_payload !== 'string' || !isBase64(raw.encrypted_payload) || base64ByteLength(raw.encrypted_payload) < MIN_PAYLOAD_BYTES) {
      pushError(errors, `${at} (${raw.item_id}): "encrypted_payload" is not valid base64 of an encrypted blob (nonce + ciphertext).`);
    }
    if (typeof raw.encrypted_item_key !== 'string' || !isBase64(raw.encrypted_item_key) || base64ByteLength(raw.encrypted_item_key) !== ITEM_KEY_BLOB_BYTES) {
      pushError(errors, `${at} (${raw.item_id}): "encrypted_item_key" is not valid base64 of a wrapped key.`);
    }
    if (raw.encryption_version !== 1) {
      pushError(errors, `${at} (${raw.item_id}): unsupported "encryption_version" ${String(raw.encryption_version)}.`);
    }
  });
  const extraErrors = errors.length > MAX_LISTED_ERRORS ? errors.length - MAX_LISTED_ERRORS : 0;
  return {
    ok: errors.length === 0,
    errors: extraErrors > 0 ? [...errors.slice(0, MAX_LISTED_ERRORS), `…and ${extraErrors} more error(s).`] : errors,
    warnings,
    formatVersion: version,
    itemCount: data.items.length,
    duplicateIds,
  };
}

/** Parse JSON text and validate it as an encrypted vault export. Never throws. */
export function parseEncryptedExportText(text: string): { validation: ImportValidation; data: VaultExport | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { validation: { ok: false, errors: ['Import file is not valid JSON.'], warnings: [], itemCount: 0, duplicateIds: [] }, data: null };
  }
  const validation = validateEncryptedExport(parsed);
  return { validation, data: validation.ok ? (parsed as VaultExport) : null };
}

/** Validate a parsed JSON value as a PLAINTEXT export (v1). Used to give a
 *  clear error when a plaintext file is offered where an encrypted backup
 *  is expected, and by desktop tooling that reads plaintext exports. */
export function validatePlaintextExport(data: unknown): ImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(data)) return { ok: false, errors: ['File is not a JSON object.'], warnings, itemCount: 0, duplicateIds: [] };
  if (data.format === ENCRYPTED_EXPORT_FORMAT) {
    return { ok: false, errors: ['This is an encrypted backup, not a plaintext export.'], warnings, itemCount: 0, duplicateIds: [] };
  }
  if (data.format !== PLAINTEXT_EXPORT_FORMAT) {
    return { ok: false, errors: ['Not a my-secrect plaintext export (unexpected "format" field).'], warnings, itemCount: 0, duplicateIds: [] };
  }
  const version = data.format_version;
  if (version !== PLAINTEXT_EXPORT_FORMAT_VERSION) {
    return { ok: false, errors: [`Unsupported plaintext export version (${String(version)}). Only version ${PLAINTEXT_EXPORT_FORMAT_VERSION} is supported.`], warnings, formatVersion: typeof version === 'number' ? version : undefined, itemCount: 0, duplicateIds: [] };
  }
  if (!Array.isArray(data.items)) {
    return { ok: false, errors: ['Plaintext export has no "items" array.'], warnings, formatVersion: version, itemCount: 0, duplicateIds: [] };
  }
  if (data.items.length > MAX_IMPORT_ITEMS) {
    return { ok: false, errors: [`Plaintext export has ${data.items.length} items, over the limit of ${MAX_IMPORT_ITEMS}.`], warnings, formatVersion: version, itemCount: data.items.length, duplicateIds: [] };
  }
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  data.items.forEach((raw, i) => {
    const at = `item ${i + 1}`;
    if (!isRecord(raw)) { pushError(errors, `${at}: not an object.`); return; }
    if (typeof raw.id !== 'string' || raw.id === '') { pushError(errors, `${at}: missing "id".`); return; }
    if (seen.has(raw.id)) { if (!duplicateIds.includes(raw.id)) duplicateIds.push(raw.id); } else seen.add(raw.id);
    if (typeof raw.type !== 'string' || raw.type === '') pushError(errors, `${at} (${raw.id}): missing "type".`);
    if (typeof raw.title !== 'string') pushError(errors, `${at} (${raw.id}): missing "title".`);
    if (!isRecord(raw.fields)) pushError(errors, `${at} (${raw.id}): missing "fields" object.`);
    if (raw.tags !== undefined && !Array.isArray(raw.tags)) pushError(errors, `${at} (${raw.id}): "tags" must be an array.`);
  });
  if (duplicateIds.length > 0) warnings.push(`${duplicateIds.length} item id(s) appear more than once.`);
  return { ok: errors.length === 0, errors, warnings, formatVersion: version, itemCount: data.items.length, duplicateIds };
}

// ---------------------------------------------------------------------------
// Login CSV import
// ---------------------------------------------------------------------------

export interface CsvDraft {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totp?: string;
  folder?: string;
  tags?: string[];
  favorite?: boolean;
  archived?: boolean;
}

export type CsvSource = 'bitwarden' | '1password' | 'google' | 'my-secret';

export const CSV_SOURCE_NAMES: Record<CsvSource, string> = {
  'my-secret': 'My Secret',
  bitwarden: 'Bitwarden',
  '1password': '1Password',
  google: 'Google Password Manager',
};

export const LOGIN_CSV_TEMPLATE = 'title,url,username,password,notes,totp_secret,folder,favorite\r\n';

export type CsvImportError = 'empty_or_malformed' | 'unrecognized' | 'no_rows' | 'too_many_rows';

export interface CsvParseResult {
  source: CsvSource | null;
  drafts: CsvDraft[];
  /** Rows skipped entirely (with 1-based row numbers). */
  skipped: Array<{ row: number; reason: string }>;
  errors: CsvImportError[];
}

/** Minimal RFC 4180 CSV reader: quoted fields, "" escapes, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const clean = text.replace(/^\uFEFF/, '');
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let closedQuote = false;
  const endField = () => { row.push(field); field = ''; fieldStarted = false; closedQuote = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; closedQuote = true; }
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) return [];
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') { if (clean[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    if (closedQuote) return [];
    field += ch;
    fieldStarted = true;
  }
  if (inQuotes) return [];
  if (field !== '' || fieldStarted || row.length > 0) endRow();
  // Drop trailing empty rows produced by a final newline.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

const BITWARDEN_COLUMNS: Record<string, keyof CsvDraft> = {
  name: 'title',
  loginusername: 'username',
  loginpassword: 'password',
  loginuri: 'url',
  logintotp: 'totp',
  notes: 'notes',
  folder: 'folder',
  favorite: 'favorite',
};

const ONEPASSWORD_COLUMNS: Record<string, keyof CsvDraft> = {
  title: 'title',
  username: 'username',
  password: 'password',
  url: 'url',
  website: 'url',
  notes: 'notes',
  onetimepassword: 'totp',
  otp: 'totp',
  totp: 'totp',
  tags: 'tags',
  favorite: 'favorite',
  favourite: 'favorite',
  favoritestatus: 'favorite',
  archived: 'archived',
  archivedstatus: 'archived',
};

const COLUMN_MAPS: Record<CsvSource, Record<string, keyof CsvDraft>> = {
  bitwarden: BITWARDEN_COLUMNS,
  '1password': ONEPASSWORD_COLUMNS,
  google: { name: 'title', url: 'url', username: 'username', password: 'password', note: 'notes' },
  'my-secret': { ...ONEPASSWORD_COLUMNS, totpsecret: 'totp', folder: 'folder' },
};

function detectSource(headers: string[]): CsvSource | null {
  if (headers.includes('loginpassword') && ['name', 'loginusername', 'loginuri'].some((h) => headers.includes(h))) return 'bitwarden';
  if (headers.includes('username') && headers.includes('password')) {
    if (headers.includes('title')) return headers.includes('totpsecret') ? 'my-secret' : '1password';
    if (headers.includes('url')) return 'google';
  }
  return null;
}

/** Normalize supported password manager exports and the My Secret template. */
export function parseCsvImport(text: string): CsvParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { source: null, drafts: [], skipped: [], errors: ['empty_or_malformed'] };
  }
  const headers = rows[0].map(normHeader);
  const source = detectSource(headers);
  if (!source) {
    return {
      source: null,
      drafts: [],
      skipped: [],
      errors: ['unrecognized'],
    };
  }
  const columnMap = COLUMN_MAPS[source];
  const typeIndex = source === 'bitwarden' ? headers.indexOf('type') : -1;
  const colIndex = new Map<keyof CsvDraft, number>();
  headers.forEach((h, i) => {
    const key = Object.prototype.hasOwnProperty.call(columnMap, h) ? columnMap[h] : undefined;
    if (key && !colIndex.has(key)) colIndex.set(key, i);
  });
  const drafts: CsvDraft[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const errors: CsvImportError[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1; // 1-based, header is row 1
    if (row.every((c) => c === '')) continue;
    const type = row[typeIndex]?.trim().toLowerCase();
    if (type && type !== 'login') {
      skipped.push({ row: rowNo, reason: 'unsupported item type' });
      continue;
    }
    if (row.length > headers.length && row.slice(headers.length).some((value) => value !== '')) {
      skipped.push({ row: rowNo, reason: 'more values than columns' });
      continue;
    }
    const get = (key: keyof CsvDraft): string => {
      const idx = colIndex.get(key);
      return idx === undefined ? '' : row[idx] ?? '';
    };
    const flag = (key: 'favorite' | 'archived') => /^(true|1|yes)$/i.test(get(key).trim());
    const draft: CsvDraft = {
      title: get('title').trim(),
      username: get('username'),
      password: get('password'),
      url: get('url').trim(),
      notes: get('notes'),
      totp: get('totp').trim() || undefined,
      folder: get('folder').trim() || undefined,
      tags: get('tags').split(',').map((tag) => tag.trim()).filter(Boolean),
      favorite: flag('favorite'),
      archived: flag('archived'),
    };
    if (!draft.title && !draft.url && !draft.username.trim()) {
      skipped.push({ row: rowNo, reason: 'no title, URL or username — nothing to import' });
      continue;
    }
    if (!draft.title) draft.title = draft.url || draft.username.trim();
    drafts.push(draft);
  }
  if (drafts.length === 0 && skipped.length === 0) errors.push('no_rows');
  if (drafts.length > MAX_IMPORT_ITEMS) {
    return { source, drafts: [], skipped, errors: ['too_many_rows'] };
  }
  return { source, drafts, skipped, errors };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export interface ExistingLoginLike {
  id: string;
  type: string;
  title: string;
  fields: Record<string, unknown>;
}

export interface CsvDuplicate {
  draftIndex: number;
  draftTitle: string;
  existingId: string;
  existingTitle: string;
  reason: string;
  fromBatch?: boolean;
}

function hostOf(url: string): string {
  const value = url.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return value.toLowerCase();
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return u.hostname.toLowerCase();
  } catch {
    // React Native's URL has no hostname getter. For ordinary web URLs the
    // hostname is enough to match logins on different paths of the same site.
    const host = /^(?:https?:\/\/)?([a-z\d.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(value)?.[1];
    return (host ?? value).toLowerCase();
  }
}

/**
 * Find drafts that already exist in the vault, so the import preview can
 * uncheck them by default instead of creating silent duplicates.
 * A draft matches when it is a login with the same (host + username), or
 * the same (title + username) when there is no URL on either side.
 */
export function detectCsvDuplicates(drafts: CsvDraft[], existing: ExistingLoginLike[]): CsvDuplicate[] {
  const signature = (title: string, url: string, username: string): string | null => {
    const user = username.trim().toLowerCase();
    const host = url ? hostOf(url) : '';
    if (host && user) return JSON.stringify(['host', host, user]);
    if (!host && title.trim()) return JSON.stringify(['title', title.trim().toLowerCase(), user]);
    return null;
  };
  const seen = new Map<string, { id: string; title: string; fromBatch?: boolean }>();
  for (const item of existing) {
    if (item.type !== 'login') continue;
    const url = typeof item.fields.url === 'string' ? item.fields.url : '';
    const username = typeof item.fields.username === 'string' ? item.fields.username : '';
    const key = signature(item.title, url, username);
    if (key && !seen.has(key)) seen.set(key, item);
  }
  const out: CsvDuplicate[] = [];
  drafts.forEach((draft, draftIndex) => {
    const key = signature(draft.title, draft.url, draft.username);
    if (!key) return;
    const match = seen.get(key);
    if (!match) {
      seen.set(key, { id: '', title: draft.title, fromBatch: true });
      return;
    }
    const reason = match.fromBatch ? 'same login in this import' :
      draft.url ? 'same site and username already in the vault' : 'same title and username already in the vault';
    out.push({ draftIndex, draftTitle: draft.title, existingId: match.id, existingTitle: match.title, reason, fromBatch: match.fromBatch });
  });
  return out;
}
