/**
 * EXAMPLE DATA ONLY — every value is fake (example.com, Example Bank,
 * 0123456789). Never present these as real secrets. Loaded only when
 * the user taps "Load example data" on an empty vault; "Clear example
 * data" permanently deletes exactly these ids.
 */
import type { VaultItem } from '../../../packages/core/src/types';
const now = '2026-11-17T00:00:00.000Z';
function base(id: string, type: VaultItem['type'], title: string, fields: Record<string, unknown>, tags: string[], relations: VaultItem['relations'] = []): VaultItem {
  return { id, type, schema_version: 1, title, fields, tags, relations, attachments: [], favorite: false, deleted_at: null, created_at: now, updated_at: now };
}
export const EXAMPLE_IDS = ['ex-login', 'ex-bank', 'ex-card', 'ex-passkey', 'ex-identity', 'ex-ssh', 'ex-api', 'ex-note', 'ex-doc', 'ex-media', 'ex-collection'];
export function exampleItems(): VaultItem[] {
  return [
    base('ex-login', 'login', 'Example Mail', { username: 'demo@example.com', password: 'Example-Password-123!', url: 'https://mail.example.com', totp_secret: 'JBSWY3DPEHPK3PXP', notes: 'Example login — not a real account.' }, ['example', 'email'], [{ type: 'has_bank', target_id: 'ex-bank' }]),
    base('ex-bank', 'bank_account', 'Example Bank — Main', { bank_name: 'Example Bank', account_number: '0123456789', currency: 'VND', holder_name: 'Example Person', branch: 'Example Branch' }, ['example', 'finance'], [{ type: 'has_login', target_id: 'ex-login' }, { type: 'has_card', target_id: 'ex-card' }]),
    base('ex-card', 'card', 'Example Bank Debit •• 4242', { cardholder: 'Example Person', last4: '4242', brand: 'Visa', expiry: '2030-12', bank: 'Example Bank', notes: 'Metadata only. No CVV or PIN is ever stored.' }, ['example', 'finance'], [{ type: 'belongs_to', target_id: 'ex-bank' }]),
    base('ex-passkey', 'passkey', 'Example Passkey — example.com', { credential_id: 'example-credential-id', rp_id: 'example.com', notes: 'Example passkey record.' }, ['example']),
    base('ex-identity', 'identity', 'Example Passport', { full_name: 'Example Person', document_number: 'EX1234567', issued_date: '2020-01-01', expiry_date: '2030-01-01', notes: 'Example identity document.' }, ['example', 'identity']),
    base('ex-ssh', 'ssh_key', 'Example SSH Key', { public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample example@example', comment: 'example-laptop', notes: 'Public key only in this example. A real private key is stored encrypted, never in plaintext.' }, ['example', 'dev']),
    base('ex-api', 'api_key', 'Example API Key', { service: 'Example API', key: 'ex_1234567890abcdef', scopes: 'read', expires_at: '2027-01-01', notes: 'Example API key.' }, ['example', 'dev']),
    base('ex-note', 'secure_note', 'Example Secure Note', { body: 'This is an example secure note. Replace it with your own notes.', checklist: '' }, ['example']),
    base('ex-doc', 'document', 'Example Contract.pdf', { blob_id: 'example-blob-doc', mime_type: 'application/pdf', notes: 'Example document metadata. File bytes are stored as an encrypted blob, not in this example.' }, ['example']),
    base('ex-media', 'media', 'Example Photo.jpg', { blob_id: 'example-blob-media', mime_type: 'image/jpeg', width: 1920, height: 1080, notes: 'Example media metadata. Thumbnail is created and encrypted on-device.' }, ['example']),
    base('ex-collection', 'collection', 'Example Project', { description: 'Example collection linking a login, an SSH key and an API key.' }, ['example'], [{ type: 'contains', target_id: 'ex-login' }, { type: 'contains', target_id: 'ex-ssh' }, { type: 'contains', target_id: 'ex-api' }]),
  ];
}
