import type { VaultItem } from '../../../../packages/core/src/types';

/**
 * EXAMPLE DATA ONLY — every value is fake (example.com, Example Bank,
 * 4242, sk-example-…). Never present these items as real credentials.
 * One item per item type (12 types, covering all 8 modules) so every
 * screen is demonstrable on a fresh vault. Items are tagged `example`
 * so they can be found and cleared again as a group.
 */

export const EXAMPLE_TAG = 'example';

function base(id: string, type: VaultItem['type'], title: string, fields: Record<string, unknown>, extra: Partial<VaultItem> = {}): VaultItem {
  const now = new Date().toISOString();
  return {
    id,
    type,
    schema_version: 1,
    title,
    fields,
    tags: [EXAMPLE_TAG],
    relations: [],
    attachments: [],
    favorite: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

export function buildExampleItems(): VaultItem[] {
  return [
    base('example-login', 'login', 'Example Website', {
      username: 'demo@example.com',
      password: 'ExamplePass123!',
      url: 'https://example.com',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      notes: 'EXAMPLE DATA — fake login for example.com.',
    }),
    base('example-passkey', 'passkey', 'Example Passkey', {
      credential_id: 'example-credential-01',
      rp_id: 'example.com',
      public_key: 'example-public-key-not-a-real-key',
      notes: 'EXAMPLE DATA — fake passkey.',
    }),
    base(
      'example-bank',
      'bank_account',
      'Example Bank',
      {
        bank_name: 'Example Bank',
        account_number: '0123456789',
        currency: 'VND',
        holder_name: 'Example Person',
        branch: 'Example Branch',
        notes: 'EXAMPLE DATA — fake bank account.',
      },
      {
        relations: [
          { type: 'has_login', target_id: 'example-login' },
          { type: 'has_card', target_id: 'example-card' },
        ],
      },
    ),
    base('example-card', 'card', 'Example Visa', {
      cardholder: 'Example Person',
      last4: '4242',
      brand: 'Visa',
      expiry: '12/30',
      bank: 'Example Bank',
      notes: 'EXAMPLE DATA — fake card metadata. No CVV is ever stored.',
    }),
    base('example-identity', 'identity', 'Example Passport', {
      full_name: 'Example Person',
      document_type: 'Passport',
      document_number: 'EX123456',
      issued_date: '2024-01-01',
      expiry_date: '2034-01-01',
      notes: 'EXAMPLE DATA — fake identity document.',
    }),
    base('example-ssh', 'ssh_key', 'Example SSH Key', {
      public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKeyNotReal example@example.com',
      comment: 'example@example.com',
      notes: 'EXAMPLE DATA — fake SSH key. No real private key is included.',
    }),
    base('example-api', 'api_key', 'Example Service API', {
      service: 'Example Service',
      key: 'sk-example-1234-not-a-real-key',
      scopes: 'read',
      expires_at: '2027-01-01',
      notes: 'EXAMPLE DATA — fake API key.',
    }),
    base('example-note', 'secure_note', 'Example Secure Note', {
      body: 'EXAMPLE DATA — this is a fake secure note.\n\nUse it to see how notes look in the vault.',
      checklist: 'Try the search\nTry favoriting this note\nTry exporting a backup',
      notes: 'EXAMPLE DATA.',
    }),
    base('example-document', 'document', 'Example Contract.pdf', {
      file_name: 'Example Contract.pdf',
      mime_type: 'application/pdf',
      size: '12345',
      blob_id: 'blob_example_document',
      sha256: 'example-sha256-not-a-real-hash',
      notes: 'EXAMPLE DATA — manifest only, no file bytes are stored.',
    }),
    base('example-media', 'media', 'Example Photo.jpg', {
      file_name: 'Example Photo.jpg',
      mime_type: 'image/jpeg',
      size: '98765',
      width: '1920',
      height: '1080',
      blob_id: 'blob_example_media',
      sha256: 'example-sha256-not-a-real-hash',
      notes: 'EXAMPLE DATA — manifest only, no file bytes are stored.',
    }),
    base('example-collection', 'collection', 'Example Project', {
      description: 'EXAMPLE DATA — a fake collection linking the example login and bank account.',
      url: 'https://example.com',
      notes: 'EXAMPLE DATA.',
    }, { relations: [{ type: 'related_to', target_id: 'example-login' }] }),
    base('example-custom', 'custom', 'Example Custom Record', {
      notes: 'EXAMPLE DATA — a fake custom record.',
      membership_id: 'EX-MEMBER-001',
      favourite_colour: 'Indigo',
    }),
  ];
}

export function isExampleItem(item: VaultItem): boolean {
  return (item.tags ?? []).includes(EXAMPLE_TAG);
}
