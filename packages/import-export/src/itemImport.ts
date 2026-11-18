import type { ItemType, VaultItem } from '../../core/src/types';
import { ITEM_SCHEMAS } from '../../schemas/src/item-types';
import { CSV_SOURCE_NAMES, detectCsvDuplicates, parseCsvImport, type CsvDraft, type CsvImportError } from './index';

export const MAX_CSV_BYTES = 8 * 1024 * 1024;
export const MAX_AI_SOURCE_BYTES = 16_384;
export const IMPORT_TEMPLATE_FILENAME = 'my-secret-logins.csv';
export const IMPORT_PREVIEW_PATH = '/v1/imports/preview';
export const IMPORT_PREVIEW_MEDIA_TYPE = 'application/vnd.my-secret.import+json';
export const OPENAI_DATA_POLICY = 'https://developers.openai.com/api/docs/guides/your-data';

const MAX_AI_ITEMS = 30;
const SUPPORTED_TYPES = ['login', 'secure_note', 'api_key', 'bank_account', 'card', 'identity', 'ssh_key'] as const;
const EXTRA_FIELDS = { identity: ['document_type'], ssh_key: ['private_key'] } as const;
const EXACT_FIELDS = new Set(['username', 'password', 'url', 'key', 'totp_secret', 'account_number', 'document_number', 'public_key', 'private_key']);

export interface ImportPreview {
  source: string;
  items: VaultItem[];
  skipped: number[];
  totpOmitted: Set<string>;
}

type TotpValidator = (secret: string) => boolean;
type CsvPreviewResult = { preview: ImportPreview } | { error: CsvImportError };

export class AiImportError extends Error {
  constructor(readonly status: number) { super('AI import request failed'); }
}

function newItemId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'item_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function importTotpSecret(value: string, isValid: TotpValidator): string | undefined {
  let secret = value;
  if (/^otpauth:/i.test(value)) {
    // React Native's URL does not expose the parsed hostname or query.
    const uri = /^otpauth:\/\/totp(?:\/[^?#]*)?\?([^#]*)/i.exec(value);
    if (!uri) return;
    try {
      const params = new Map<string, string>();
      for (const pair of uri[1].split('&')) {
        const match = /^([^=]+)=(.*)$/.exec(pair);
        if (!match) continue;
        const key = decodeURIComponent(match[1]);
        if (!params.has(key)) params.set(key, decodeURIComponent(match[2].replace(/\+/g, ' ')));
      }
      if ((params.get('algorithm') ?? 'SHA1').toUpperCase() !== 'SHA1' ||
          (params.get('digits') ?? '6') !== '6' || (params.get('period') ?? '30') !== '30') return;
      secret = params.get('secret') ?? '';
    } catch {
      return;
    }
  }
  const clean = secret.replace(/\s/g, '').toUpperCase();
  return isValid(clean) ? clean : undefined;
}

export function csvDraftToLoginItem(draft: CsvDraft, isValidTotp: TotpValidator): VaultItem {
  const fields: Record<string, unknown> = {
    username: draft.username,
    password: draft.password,
    url: draft.url,
  };
  const secret = draft.totp && importTotpSecret(draft.totp, isValidTotp);
  if (secret) fields.totp_secret = secret;
  if (draft.notes) fields.notes = draft.notes;
  if (draft.archived) fields.archived = true;
  const tags = [...(draft.tags ?? [])];
  if (draft.folder) tags.push(draft.folder);
  return newImportedItem('login', draft.title, fields, tags, draft.favorite);
}

export function buildCsvPreview(text: string, isValidTotp: TotpValidator): CsvPreviewResult {
  const result = parseCsvImport(text);
  if (!result.source || result.errors.length > 0) return { error: result.errors[0] ?? 'unrecognized' };
  const items = result.drafts.map((draft) => csvDraftToLoginItem(draft, isValidTotp));
  return { preview: {
    source: CSV_SOURCE_NAMES[result.source],
    items,
    skipped: result.skipped.map(({ row }) => row),
    totpOmitted: new Set(items.filter((item, i) => result.drafts[i].totp && !item.fields.totp_secret).map((item) => item.id)),
  } };
}

export function fieldText(item: VaultItem, key: string): string {
  const value = item.fields[key];
  return typeof value === 'string' ? value : '';
}

export function previewDuplicates(items: VaultItem[], existingItems: VaultItem[]): Map<string, boolean> {
  const logins = items.filter((item) => item.type === 'login');
  const drafts = logins.map((item) => ({
    title: item.title,
    username: fieldText(item, 'username'),
    url: fieldText(item, 'url'),
    password: '',
    notes: '',
  }));
  return new Map(detectCsvDuplicates(drafts, existingItems).map((dupe) => [
    logins[dupe.draftIndex].id, dupe.fromBatch === true,
  ]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAiPreview(response: unknown, source: string, isValidTotp: TotpValidator): ImportPreview {
  if (!isRecord(response) || !Array.isArray(response.items) || response.items.length > MAX_AI_ITEMS) {
    throw new Error('Invalid AI import response');
  }
  const items: VaultItem[] = [];
  const skipped: number[] = [];
  const totpOmitted = new Set<string>();
  response.items.forEach((raw: unknown, index: number) => {
    const type = isRecord(raw) ? SUPPORTED_TYPES.find((kind) => kind === raw.type) : undefined;
    if (!isRecord(raw) || !type || typeof raw.title !== 'string' || !raw.title.trim() || !isRecord(raw.fields)) {
      skipped.push(index + 1);
      return;
    }
    const schema = ITEM_SCHEMAS[type];
    const allowed = new Set<string>([...schema.required, ...schema.optional]);
    // These fields also exist in the desktop editor and are stored as strings.
    if (type === 'identity' || type === 'ssh_key') {
      for (const field of EXTRA_FIELDS[type]) allowed.add(field);
    }
    // A checklist needs structured entries. SSH import takes key text, which
    // the editor already supports.
    allowed.delete('checklist');
    allowed.delete('private_key_ref');
    // Preserve the AI preview contract, which permits only the last four digits.
    allowed.delete('card_number');
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.fields)) {
      if (value === null || value === '') continue;
      if (!allowed.has(key) || typeof value !== 'string' ||
          (EXACT_FIELDS.has(key) && !source.includes(value))) {
        skipped.push(index + 1);
        return;
      }
      fields[key] = value;
    }
    const hasRequired = type === 'login'
      ? Boolean(fields.username?.trim() || fields.password || fields.url?.trim())
      : schema.required.every((key) => fields[key]?.trim());
    if (!hasRequired || (type === 'card' && !/^\d{4}$/.test(fields.last4))) {
      skipped.push(index + 1);
      return;
    }
    const item = newImportedItem(type, raw.title.trim(), fields);
    if (fields.totp_secret) {
      const secret = importTotpSecret(fields.totp_secret, isValidTotp);
      if (secret) fields.totp_secret = secret;
      else {
        delete fields.totp_secret;
        totpOmitted.add(item.id);
      }
    }
    items.push(item);
  });
  return { source: 'OpenAI', items, skipped, totpOmitted };
}

function newImportedItem(type: ItemType, title: string, fields: Record<string, unknown>, tags: string[] = [], favorite = false): VaultItem {
  const now = new Date().toISOString();
  return {
    id: newItemId(),
    type,
    schema_version: 1,
    title,
    fields,
    tags: [...new Set(['imported', ...tags])],
    relations: [],
    attachments: [],
    favorite,
    created_at: now,
    updated_at: now,
  };
}
