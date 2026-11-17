/**
 * A vault data set that exercises every relation the data model has:
 * typed relations (bank -> login / card), tags, favorites, attachments
 * (blob ids + blob_id field), nested collections (fields.parent_id), a
 * custom item with free-form fields, unicode, and a long note. Shared by
 * the portable-backup and recovery-failure acceptance tests.
 *
 * Every item is a plain VaultItem as the apps store it. Ids use the same
 * shape as packages/core newItemId() ("item_" + 32 hex) so the sync wire-id
 * mapping and UI treat them like ids the app generated itself.
 */
import type { VaultItem } from '../../../packages/core/src/types';

const T0 = '2026-11-17T08:00:00.000Z';
const id = (suffix: string) => `item_${suffix.padEnd(32, '0').slice(0, 32)}`;

export const IDS = {
  bank: id('acc0ba1c'),
  login: id('acc010917'),
  card: id('acc0ca7d'),
  identity: id('acc01de7'),
  note: id('acc0907e'),
  doc: id('acc0d0c5'),
  ssh: id('acc055a1'),
  apiKey: id('acc0a919'),
  folderRoot: id('acc0f01d'),
  folderChild: id('acc0f02d'),
  custom: id('acc0c057'),
  trashed: id('acc07a54'),
} as const;

function item(partial: Partial<VaultItem> & Pick<VaultItem, 'id' | 'type' | 'title' | 'fields'>): VaultItem {
  return {
    schema_version: 1,
    tags: [],
    relations: [],
    attachments: [],
    favorite: false,
    created_at: T0,
    updated_at: T0,
    ...partial,
  };
}

/** Live items (not trashed). */
export function richItems(marker = 'ACC'): VaultItem[] {
  return [
    item({
      id: IDS.bank, type: 'bank_account', title: `${marker} Main Bank`,
      fields: { bank_name: 'Example Bank', account_number: '0123456789', currency: 'VND', holder_name: 'Nguyễn Văn Ví Dụ' },
      tags: ['finance', 'personal'],
      relations: [
        { type: 'has_login', target_id: IDS.login },
        { type: 'has_card', target_id: IDS.card },
        { type: 'owned_by', target_id: IDS.identity },
      ],
      favorite: true,
    }),
    item({
      id: IDS.login, type: 'login', title: `${marker} Bank login`,
      fields: { username: 'vi.du', password: `${marker}-pw-Ωmega-9!`, url: 'https://bank.example.test/login', totp_secret: 'JBSWY3DPEHPK3PXP' },
      tags: ['finance'],
      relations: [{ type: 'login_for', target_id: IDS.bank }],
      favorite: true,
    }),
    item({
      id: IDS.card, type: 'card', title: `${marker} Debit card`,
      fields: { cardholder: 'NGUYEN VAN VI DU', number: '4111111111111111', expiry: '12/30', brand: 'visa' },
      tags: ['finance'],
      relations: [{ type: 'card_of', target_id: IDS.bank }],
    }),
    item({
      id: IDS.identity, type: 'identity', title: `${marker} Me`,
      fields: { full_name: 'Nguyễn Văn Ví Dụ', email: 'vidu@example.test', phone: '+84 000 000 000' },
      tags: ['personal'],
    }),
    item({
      id: IDS.note, type: 'secure_note', title: `${marker} Recovery notes 📝`,
      fields: { notes: `${marker} line 1\nline 2 — em dash\n` + 'x'.repeat(4000) },
      tags: ['personal', 'notes'],
      relations: [{ type: 'mentions', target_id: IDS.bank }],
    }),
    item({
      id: IDS.doc, type: 'document', title: `${marker} Passport scan.pdf`,
      fields: { file_name: 'passport.pdf', blob_id: 'blob_00000000-0000-4000-8000-0000000000aa', mime_type: 'application/pdf', size_bytes: 123456, size: '123456', sha256: 'ab'.repeat(32) },
      attachments: ['blob_00000000-0000-4000-8000-0000000000aa'],
      relations: [{ type: 'document_of', target_id: IDS.identity }],
      tags: ['documents'],
    }),
    item({
      id: IDS.ssh, type: 'ssh_key', title: `${marker} Deploy key`,
      fields: { public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcceptanceOnlyNotARealKey', private_key: `-----BEGIN OPENSSH PRIVATE KEY-----\n${marker}-fake\n-----END OPENSSH PRIVATE KEY-----` },
      tags: ['work'],
    }),
    item({
      id: IDS.apiKey, type: 'api_key', title: `${marker} CI token`,
      fields: { key: `${marker}-api-key-0000`, service: 'example-ci' },
      tags: ['work'],
      relations: [{ type: 'related_to', target_id: IDS.ssh }],
    }),
    item({
      id: IDS.folderRoot, type: 'collection', title: `${marker} Finance folder`,
      fields: { description: 'top-level folder' },
      relations: [
        { type: 'contains', target_id: IDS.bank },
        { type: 'contains', target_id: IDS.card },
      ],
    }),
    item({
      id: IDS.folderChild, type: 'collection', title: `${marker} Taxes 2026`,
      fields: { parent_id: IDS.folderRoot, description: 'nested folder' },
      relations: [{ type: 'contains', target_id: IDS.doc }],
    }),
    item({
      id: IDS.custom, type: 'custom', title: `${marker} Wi-Fi`,
      fields: { ssid: 'home-5g', passphrase: `${marker}-wifi`, nested: { band: '5GHz', channels: [36, 40] } },
      tags: [],
    }),
  ];
}

/** An item the tests move to trash before exporting. */
export function trashedItem(marker = 'ACC'): VaultItem {
  return item({
    id: IDS.trashed, type: 'login', title: `${marker} Old login (trashed)`,
    fields: { username: 'old', password: `${marker}-old-pw`, url: 'https://old.example.test' },
  });
}

/** Fields the apps add/rewrite on write; everything else must survive byte-for-byte. */
export function comparable(i: VaultItem) {
  const { updated_at: _u, deleted_at: _d, ...rest } = i;
  return { ...rest, favorite: rest.favorite ?? false };
}

export function byId<T extends { id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}

/** Every relation target and every nested-collection parent must exist in `items`. */
export function danglingReferences(items: VaultItem[]): string[] {
  const ids = new Set(items.map((i) => i.id));
  const out: string[] = [];
  for (const i of items) {
    for (const r of i.relations) if (!ids.has(r.target_id)) out.push(`${i.id} -${r.type}-> ${r.target_id}`);
    const parent = (i.fields as Record<string, unknown>).parent_id;
    if (typeof parent === 'string' && !ids.has(parent)) out.push(`${i.id} parent_id -> ${parent}`);
  }
  return out;
}
