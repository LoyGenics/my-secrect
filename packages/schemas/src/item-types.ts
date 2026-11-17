/** Item schemas — field lists per type. Server never sees field names in plaintext;
 *  these schemas live on the client and validate the plaintext BEFORE encryption. */
export const ITEM_SCHEMAS = {
  login: { required: ['username'], optional: ['password', 'url', 'totp_secret', 'notes'] },
  passkey: { required: ['credential_id', 'rp_id'], optional: ['public_key', 'notes'] },
  bank_account: { required: ['bank_name', 'account_number'], optional: ['currency', 'holder_name', 'branch', 'notes'] },
  // NOTE: never store CVV / PIN on the server. Card metadata only; CVV is out of scope for v1.
  card: { required: ['cardholder', 'last4'], optional: ['brand', 'expiry', 'bank', 'notes'] },
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
