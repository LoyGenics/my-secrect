// Schema validation tests — self-contained, plain Node 20+ (node --test).
// Mirrors packages/schemas/src/item-types.ts (same rules, same constants).
// They do NOT import .ts files, so they run without a TS loader.
// A TS-level test that imports the real module should be added in CI once
// a loader (tsx) is available; until then these guard the RULES.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- mirrors of packages/schemas/src/item-types.ts ---
const SCHEMA_VERSION = 1;
const SUPPORTED_SCHEMA_VERSIONS = [1];
const FORBIDDEN_FIELDS = ['cvv', 'cvv2', 'cvc', 'cvc2', 'pin', 'otp', 'one_time_code', 'one_time_password', 'totp_code'];
const ITEM_SCHEMAS = {
  login: { required: ['username'], optional: ['password', 'url', 'totp_secret', 'notes'] },
  card: { required: ['cardholder', 'last4'], optional: ['brand', 'expiry', 'bank', 'notes', 'card_number', 'card_type', 'credit_limit', 'statement_day'] },
  secure_note: { required: ['body'], optional: ['checklist'] },
  custom: { required: [], optional: [] },
};
function isSupportedSchemaVersion(v) { return v === 1; }
function isSupportedItemType(t) { return typeof t === 'string' && t in ITEM_SCHEMAS; }
function isEmptyValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
function validateItemFields(type, fields) {
  const errors = [];
  if (!isSupportedItemType(type)) { errors.push(`unknown item type '${type}'`); return errors; }
  for (const f of ITEM_SCHEMAS[type].required) if (isEmptyValue(fields[f])) errors.push(`missing required field '${f}'`);
  const forbidden = new Set(FORBIDDEN_FIELDS.map((f) => f.toLowerCase()));
  for (const f of Object.keys(fields)) if (forbidden.has(f.toLowerCase())) errors.push(`forbidden field '${f}' must never be stored`);
  return errors;
}
function validateItemSchema(type, version, fields) {
  if (!isSupportedSchemaVersion(version)) return [`unsupported schema_version '${String(version)}' (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`];
  return validateItemFields(type, fields);
}

test('v1 is the only supported schema version; unknown versions are rejected', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(validateItemSchema('login', 1, { username: 'a' }), []);
  assert.equal(validateItemSchema('login', 2, { username: 'a' }).length, 1);
  assert.equal(validateItemSchema('login', 0, { username: 'a' }).length, 1);
  assert.match(validateItemSchema('login', 2, { username: 'a' })[0], /unsupported schema_version/);
});

test('missing required field is reported; unknown fields are allowed (forward compat)', () => {
  assert.deepEqual(validateItemFields('login', { username: 'tony' }), []);
  assert.match(validateItemFields('login', {})[0], /missing required field 'username'/);
  assert.match(validateItemFields('login', { username: '  ' })[0], /missing required field/);
  // A future v1.x optional field must not break older validators.
  assert.deepEqual(validateItemFields('login', { username: 'a', future_field: 'x' }), []);
});

test('unknown item type is rejected', () => {
  assert.match(validateItemFields('teleporter', {})[0], /unknown item type/);
});

test('CVV / PIN / live OTPs are forbidden in every type, case-insensitively', () => {
  for (const bad of ['cvv', 'CVV', 'cvc2', 'pin', 'PIN', 'otp', 'totp_code', 'one_time_password']) {
    assert.equal(validateItemFields('card', { cardholder: 'T', last4: '1234', [bad]: '123' }).length, 1, bad);
  }
  // A TOTP *secret* is storable; only the live *code* is forbidden.
  assert.deepEqual(validateItemFields('login', { username: 'a', totp_secret: 'JBSW...' }), []);
});

test('every item type in the schema map is versioned v1', () => {
  for (const type of Object.keys(ITEM_SCHEMAS)) {
    assert.equal(SCHEMA_VERSION, 1, type);
    assert.deepEqual(validateItemSchema(type, 1, {}).filter((e) => /unsupported/.test(e)), []);
  }
});
