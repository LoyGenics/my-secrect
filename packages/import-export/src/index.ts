/**
 * Import / export — portable formats, validation, and CSV import.
 *
 * This package is PURE (no I/O, no crypto, no storage): it validates
 * shapes, versions and base64, and parses other password managers'
 * CSV exports into drafts. Decryption / encryption of the rows lives
 * in the vault implementations (apps/desktop/src/vault.ts,
 * apps/mobile/src/vault.ts), which reject rows they cannot open.
 *
 * Formats (all JSON, versioned):
 *  - Encrypted vault export: format 'my-secrect-vault-export',
 *    format_version 1. Items carry only opaque encrypted blobs
 *    (`nonce || ciphertext` and `wrapped nonce || wrapped key`, base64).
 *    Trash rows are never exported. A plaintext export is a DIFFERENT
 *    format ('my-secrect-vault-plaintext-export') and is NEVER accepted
 *    by the encrypted-import path — the two must never be confused.
 *  - Plaintext export: same versioning, items are VaultItem plaintext.
 *    Desktop-only, behind an explicit warning + confirm checkbox.
 *    The web client offers encrypted-only export.
 *
 * Version policy: format_version 1 is the only supported version.
 * A newer version is REJECTED ("created by a newer version — update
 * the app"), never silently imported. An older/unknown version is
 * rejected the same way. Tampered rows fail the AEAD authentication
 * check at import time in the vault and are skipped, never stored.
 */

export const EXPORT_FORMAT_VERSION = 1;
export const ENCRYPTED_EXPORT_FORMAT = 'my-secrect-vault-export';
export const PLAINTEXT_EXPORT_FORMAT = 'my-secrect-vault-plaintext-export';
/** Hard cap on rows in one import file — a larger file is rejected, not truncated. */
export const MAX_IMPORT_ITEMS = 10_000;
/** Max validation errors listed before the rest are summarised as a count. */
const MAX_LISTED_ERRORS = 10;

export interface VaultExport {
  format: 'my-secrect-vault-export';
  format_version: number;
  exported_at: string;
  vault_id: string;
  items: Array<{ item_id: string; revision: number; encrypted_payload: string; encrypted_item_key: string; encryption_version: number }>;
  relations_included: boolean;
}

export function buildExportSkeleton(vaultId: string): VaultExport {
  return { format: 'my-secrect-vault-export', format_version: EXPORT_FORMAT_VERSION, exported_at: new Date().toISOString(), vault_id: vaultId, items: [], relations_included: true };
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

/** Validate a parsed JSON value as an encrypted vault export (v1). */
export function validateEncryptedExport(data: unknown): ImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const duplicateIds: string[] = [];
  if (!isRecord(data)) return { ok: false, errors: ['Import file is not a JSON object.'], warnings, itemCount: 0, duplicateIds };
  if (data.format === PLAINTEXT_EXPORT_FORMAT) {
    return { ok: false, errors: ['This is a plaintext export. Plaintext files cannot be imported as an encrypted backup — use a desktop encrypted backup instead.'], warnings, itemCount: 0, duplicateIds };
  }
  if (data.format !== ENCRYPTED_EXPORT_FORMAT) {
    return { ok: false, errors: ['Not a my-secrect vault export (unexpected "format" field).'], warnings, itemCount: 0, duplicateIds };
  }
  const version = data.format_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, errors: ['Export is missing a valid "format_version".'], warnings, itemCount: 0, duplicateIds };
  }
  if (version > EXPORT_FORMAT_VERSION) {
    return { ok: false, errors: [`Export was created by a newer version (format_version ${version}). Update this app before importing it.`], warnings, formatVersion: version, itemCount: 0, duplicateIds };
  }
  if (version < EXPORT_FORMAT_VERSION) {
    return { ok: false, errors: [`Unsupported export version (format_version ${version}). Only version ${EXPORT_FORMAT_VERSION} can be imported.`], warnings, formatVersion: version, itemCount: 0, duplicateIds };
  }
  if (typeof data.exported_at === 'string' && Number.isNaN(Date.parse(data.exported_at))) {
    warnings.push('"exported_at" is not a valid date; continuing anyway.');
  }
  if (data.vault_id !== undefined && (typeof data.vault_id !== 'string' || data.vault_id === '')) {
    warnings.push('"vault_id" is missing or empty; continuing anyway.');
  }
  if (data.relations_included !== undefined && typeof data.relations_included !== 'boolean') {
    warnings.push('"relations_included" is not a boolean; continuing anyway.');
  }
  if (!Array.isArray(data.items)) {
    return { ok: false, errors: ['Export has no "items" array.'], warnings, formatVersion: version, itemCount: 0, duplicateIds };
  }
  if (data.items.length > MAX_IMPORT_ITEMS) {
    return { ok: false, errors: [`Export has ${data.items.length} items, over the limit of ${MAX_IMPORT_ITEMS}. Split the file and import it in parts.`], warnings, formatVersion: version, itemCount: data.items.length, duplicateIds };
  }
  const seen = new Set<string>();
  data.items.forEach((raw, i) => {
    const at = `item ${i + 1}`;
    if (!isRecord(raw)) { pushError(errors, `${at}: not an object.`); return; }
    if (typeof raw.item_id !== 'string' || raw.item_id === '') { pushError(errors, `${at}: missing "item_id".`); return; }
    if (seen.has(raw.item_id)) {
      if (!duplicateIds.includes(raw.item_id)) duplicateIds.push(raw.item_id);
    } else seen.add(raw.item_id);
    if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0) {
      pushError(errors, `${at} (${raw.item_id}): "revision" must be a non-negative integer.`);
    }
    if (typeof raw.encrypted_payload !== 'string' || !isBase64(raw.encrypted_payload) || base64ByteLength(raw.encrypted_payload) < 40) {
      pushError(errors, `${at} (${raw.item_id}): "encrypted_payload" is not valid base64 of an encrypted blob (nonce + ciphertext).`);
    }
    if (typeof raw.encrypted_item_key !== 'string' || !isBase64(raw.encrypted_item_key) || base64ByteLength(raw.encrypted_item_key) < 40) {
      pushError(errors, `${at} (${raw.item_id}): "encrypted_item_key" is not valid base64 of a wrapped key.`);
    }
    if (raw.encryption_version !== undefined && raw.encryption_version !== 1) {
      pushError(errors, `${at} (${raw.item_id}): unsupported "encryption_version" ${String(raw.encryption_version)}.`);
    }
  });
  if (duplicateIds.length > 0) {
    warnings.push(`${duplicateIds.length} item id(s) appear more than once; the highest revision wins.`);
  }
  const extraErrors = errors.length > MAX_LISTED_ERRORS ? errors.length - MAX_LISTED_ERRORS : 0;
  return {
    ok: errors.length === 0,
    errors: extraErrors > 0 ? [...errors, `…and ${extraErrors} more error(s).`] : errors,
    warnings,
    formatVersion: version,
    itemCount: Array.isArray(data.items) ? data.items.length : 0,
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
  if (version !== EXPORT_FORMAT_VERSION) {
    return { ok: false, errors: [`Unsupported plaintext export version (${String(version)}). Only version ${EXPORT_FORMAT_VERSION} is supported.`], warnings, formatVersion: typeof version === 'number' ? version : undefined, itemCount: 0, duplicateIds: [] };
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
// CSV import (1Password / Bitwarden)
// ---------------------------------------------------------------------------

export interface CsvDraft {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  totp?: string;
  folder?: string;
  favorite?: boolean;
}

export type CsvSource = 'bitwarden' | '1password';

export interface CsvParseResult {
  source: CsvSource;
  drafts: CsvDraft[];
  /** Rows skipped entirely (with 1-based row numbers). */
  skipped: Array<{ row: number; reason: string }>;
  /** Non-fatal notes, e.g. rows imported without a password. */
  warnings: string[];
  errors: string[];
}

/** Minimal RFC 4180 CSV reader: quoted fields, "" escapes, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const clean = text.replace(/^\uFEFF/, '');
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const endField = () => { row.push(field); field = ''; fieldStarted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') { inQuotes = true; fieldStarted = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') { if (clean[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    fieldStarted = true;
  }
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
};

function detectSource(headers: string[]): CsvSource | null {
  const norm = headers.map(normHeader);
  if (norm.includes('loginusername') || norm.includes('loginpassword') || norm.includes('loginuri')) return 'bitwarden';
  if (norm.includes('title') && norm.includes('username') && norm.includes('password')) return '1password';
  return null;
}

/** Parse a 1Password or Bitwarden CSV export into login drafts. Never throws
 *  on malformed rows — they are reported in `skipped`/`errors` instead. */
export function parseCsvImport(text: string): CsvParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { source: 'bitwarden', drafts: [], skipped: [], warnings: [], errors: ['CSV file is empty.'] };
  }
  const headers = rows[0];
  const source = detectSource(headers);
  if (!source) {
    return {
      source: 'bitwarden',
      drafts: [],
      skipped: [],
      warnings: [],
      errors: ['Could not recognise this CSV. Expected a Bitwarden export (columns: name, login_username, login_password, login_uri, …) or a 1Password export (Title, Username, Password, URL, …).'],
    };
  }
  const columnMap = source === 'bitwarden' ? BITWARDEN_COLUMNS : ONEPASSWORD_COLUMNS;
  const colIndex = new Map<keyof CsvDraft, number>();
  headers.forEach((h, i) => {
    const key = columnMap[normHeader(h)];
    if (key && !colIndex.has(key)) colIndex.set(key, i);
  });
  if (!colIndex.has('title') && !colIndex.has('url') && !colIndex.has('username')) {
    return { source, drafts: [], skipped: [], warnings: [], errors: [`${source === 'bitwarden' ? 'Bitwarden' : '1Password'} CSV is missing its title/URL/username columns.`] };
  }
  const drafts: CsvDraft[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1; // 1-based, header is row 1
    if (row.every((c) => c.trim() === '')) continue;
    const get = (key: keyof CsvDraft): string => {
      const idx = colIndex.get(key);
      if (idx === undefined) return '';
      const v = row[idx];
      return typeof v === 'string' ? v.trim() : '';
    };
    const draft: CsvDraft = {
      title: get('title'),
      username: get('username'),
      password: get('password'),
      url: get('url'),
      notes: get('notes'),
      totp: get('totp') || undefined,
      folder: get('folder') || undefined,
      favorite: source === 'bitwarden' ? /^(true|1|yes)$/i.test(get('favorite')) : undefined,
    };
    if (!draft.title && !draft.url && !draft.username) {
      skipped.push({ row: rowNo, reason: 'no title, URL or username — nothing to import' });
      continue;
    }
    if (!draft.title) draft.title = draft.url || draft.username;
    if (!draft.password) warnings.push(`Row ${rowNo} (“${draft.title}”): no password stored — imported without one.`);
    if (draft.totp && !/^[A-Z2-7]+=*$/i.test(draft.totp.replace(/\s+/g, ''))) {
      warnings.push(`Row ${rowNo} (“${draft.title}”): TOTP value does not look like Base32 — it was kept as-is; check it after import.`);
    }
    drafts.push(draft);
  }
  if (drafts.length === 0 && skipped.length === 0 && warnings.length === 0) {
    errors.push('CSV has a header row but no data rows.');
  }
  if (drafts.length > MAX_IMPORT_ITEMS) {
    return { source, drafts: [], skipped, warnings, errors: [`CSV has ${drafts.length} logins, over the limit of ${MAX_IMPORT_ITEMS}. Split the file and import it in parts.`] };
  }
  return { source, drafts, skipped, warnings, errors };
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
}

function hostOf(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Find drafts that already exist in the vault, so the import preview can
 * uncheck them by default instead of creating silent duplicates.
 * A draft matches when it is a login with the same (host + username), or
 * the same (title + username) when there is no URL on either side.
 */
export function detectCsvDuplicates(drafts: CsvDraft[], existing: ExistingLoginLike[]): CsvDuplicate[] {
  const out: CsvDuplicate[] = [];
  drafts.forEach((draft, draftIndex) => {
    const dHost = draft.url ? hostOf(draft.url) : '';
    const dUser = draft.username.trim().toLowerCase();
    const dTitle = draft.title.trim().toLowerCase();
    for (const item of existing) {
      if (item.type !== 'login') continue;
      const eUser = typeof item.fields.username === 'string' ? item.fields.username.trim().toLowerCase() : '';
      const eUrl = typeof item.fields.url === 'string' ? item.fields.url : '';
      const eHost = eUrl ? hostOf(eUrl) : '';
      const eTitle = item.title.trim().toLowerCase();
      if (dHost && eHost && dHost === eHost && dUser === eUser && dUser !== '') {
        out.push({ draftIndex, draftTitle: draft.title, existingId: item.id, existingTitle: item.title, reason: 'same site and username already in the vault' });
        return;
      }
      if (!dHost && !eHost && dTitle && dTitle === eTitle && dUser === eUser) {
        out.push({ draftIndex, draftTitle: draft.title, existingId: item.id, existingTitle: item.title, reason: 'same title and username already in the vault' });
        return;
      }
    }
  });
  return out;
}
