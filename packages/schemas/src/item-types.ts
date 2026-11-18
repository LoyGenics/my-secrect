/** Item schemas — field lists per type. Server never sees field names in plaintext;
 *  these schemas live on the client and validate the plaintext BEFORE encryption. */
export const ITEM_SCHEMAS = {
  login: { required: ['username'], optional: ['password', 'url', 'totp_secret', 'notes'] },
  passkey: { required: ['credential_id', 'rp_id'], optional: ['public_key', 'notes'] },
  bank_account: { required: ['bank_name', 'account_number'], optional: ['currency', 'holder_name', 'branch', 'notes'] },
  // Keep last4 for older records and clients. CVV is device-local and outside this schema.
  card: { required: ['cardholder', 'last4'], optional: ['brand', 'expiry', 'bank', 'notes', 'card_number', 'card_type', 'credit_limit', 'statement_day'] },
  identity: { required: ['full_name'], optional: ['document_number', 'issued_date', 'expiry_date', 'notes'] },
  ssh_key: { required: ['public_key'], optional: ['private_key_ref', 'comment', 'notes'] },
  api_key: { required: ['service'], optional: ['key', 'scopes', 'expires_at', 'notes'] },
  secure_note: { required: ['body'], optional: ['checklist'] },
  document: { required: ['blob_id'], optional: ['mime_type', 'notes'] },
  media: { required: ['blob_id'], optional: ['mime_type', 'width', 'height', 'duration_s', 'notes'] },
  collection: { required: [], optional: ['description'] },
  custom: { required: [], optional: [] },
} as const;

export type ItemTypeName = keyof typeof ITEM_SCHEMAS;

// ---------------------------------------------------------------------------
// Versioned schemas (Phase C). Every item type is versioned; v1 is the
// only supported version. Rules (see packages/schemas/README.md):
//  - Additive only: new fields are optional, existing fields are never
//    renamed or removed. A breaking change ships as a NEW version.
//  - Unknown schema versions are REJECTED, never silently accepted.
//  - Forbidden fields are never stored in item payloads, in any version: CVV/CVC,
//    any PIN, and live one-time codes. (A TOTP *secret* is storable;
//    a live TOTP *code* is not — it expires in 30s and must never be
//    persisted.)
// ---------------------------------------------------------------------------
export const SCHEMA_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export function isSupportedSchemaVersion(version: unknown): version is 1 {
  return version === 1;
}

export function isSupportedItemType(type: unknown): type is ItemTypeName {
  return typeof type === 'string' && type in ITEM_SCHEMAS;
}

/** Field names that must never be stored in a vault item payload. */
export const FORBIDDEN_FIELDS: readonly string[] = [
  'cvv', 'cvv2', 'cvc', 'cvc2', // excluded from sync, export and sharing
  'pin', // any PIN — never stored
  'otp', 'one_time_code', 'one_time_password', 'totp_code', // live one-time codes — never stored
];

export interface VersionedItemSchema {
  version: number;
  required: readonly string[];
  optional: readonly string[];
  /** Forbidden fields for this type (always includes FORBIDDEN_FIELDS). */
  forbidden: readonly string[];
}

/** Versioned view of the additive item schemas above. */
export const ITEM_SCHEMA_VERSIONS: Record<ItemTypeName, VersionedItemSchema> = Object.fromEntries(
  (Object.keys(ITEM_SCHEMAS) as ItemTypeName[]).map((type) => [
    type,
    {
      version: SCHEMA_VERSION,
      required: ITEM_SCHEMAS[type].required,
      optional: ITEM_SCHEMAS[type].optional,
      forbidden: FORBIDDEN_FIELDS,
    } satisfies VersionedItemSchema,
  ]),
// Object.fromEntries widens keys to string; every ItemTypeName key is built above.
) as unknown as Record<ItemTypeName, VersionedItemSchema>;

export function getItemSchema(type: ItemTypeName): VersionedItemSchema {
  return ITEM_SCHEMA_VERSIONS[type];
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Validate plaintext fields for one item type, BEFORE encryption.
 * Returns a list of problems; an empty list means valid. Checks:
 *  - unknown item type
 *  - every required field present and non-empty
 *  - no forbidden field present (CVV/PIN/live OTP), matched case-insensitively
 * Unknown (non-required, non-forbidden) fields are ALLOWED: v1.x may add
 * optional fields without breaking older clients (forward compatibility).
 */
export function validateItemFields(type: string, fields: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isSupportedItemType(type)) {
    errors.push(`unknown item type '${type}'`);
    return errors;
  }
  const schema = ITEM_SCHEMA_VERSIONS[type];
  for (const field of schema.required) {
    if (isEmptyValue(fields[field])) errors.push(`missing required field '${field}'`);
  }
  const forbidden = new Set(schema.forbidden.map((f) => f.toLowerCase()));
  for (const field of Object.keys(fields)) {
    if (forbidden.has(field.toLowerCase())) {
      errors.push(`forbidden field '${field}' must never be stored`);
    }
  }
  return errors;
}

/**
 * Validate a whole item's schema version + fields. Returns problems, [] if valid.
 * `schemaVersion` must be a supported version (v1 only, today).
 */
export function validateItemSchema(
  type: string,
  schemaVersion: unknown,
  fields: Record<string, unknown>,
): string[] {
  if (!isSupportedSchemaVersion(schemaVersion)) {
    return [`unsupported schema_version '${String(schemaVersion)}' (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`];
  }
  return validateItemFields(type, fields);
}
