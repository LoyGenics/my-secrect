import type { VaultItem } from '../../../../packages/core/src/types';
import { ITEM_SCHEMAS } from '../../../../packages/schemas/src/item-types';
import { getValidToken, webTokenStore } from '../../../../packages/sdk/src/index';
import { importTotpSecret, newImportedItem } from './csvImport';

export const MAX_AI_SOURCE_BYTES = 16_384;
const MAX_AI_ITEMS = 30;
const SUPPORTED_TYPES = ['login', 'secure_note', 'api_key', 'bank_account', 'card', 'identity', 'ssh_key'] as const;
const EXTRA_FIELDS = { identity: ['document_type'], ssh_key: ['private_key'] } as const;
const EXACT_FIELDS = new Set(['username', 'password', 'url', 'key', 'totp_secret', 'account_number', 'document_number', 'public_key', 'private_key']);

export class AiImportError extends Error {
  constructor(readonly status: number) { super('AI import request failed'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAiPreview(response: unknown, source: string): { items: VaultItem[]; skipped: number[] } {
  if (!isRecord(response) || !Array.isArray(response.items) || response.items.length > MAX_AI_ITEMS) {
    throw new Error('Invalid AI import response');
  }
  const items: VaultItem[] = [];
  const skipped: number[] = [];
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
    items.push(newImportedItem(type, raw.title.trim(), fields));
  });
  return { items, skipped };
}

/** The consent dialog is the only caller. Keep this separate from vault sync. */
export async function requestAiPreview(baseUrl: string, source: string, signal: AbortSignal) {
  const endpoint = new URL(baseUrl, window.location.href);
  const localHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !localHttp) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new AiImportError(503);
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/v1/imports/preview';
  const token = await getValidToken(webTokenStore());
  if (!token) throw new AiImportError(401);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.my-secret.import+json' },
    body: JSON.stringify({ consent: true, source_text: source }),
    signal,
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new AiImportError(response.status);
  const result = normalizeAiPreview(await response.json(), source);
  const totpOmitted = new Set<string>();
  for (const item of result.items) {
    const raw = item.fields.totp_secret;
    if (typeof raw !== 'string') continue;
    const secret = importTotpSecret(raw);
    if (secret) item.fields.totp_secret = secret;
    else {
      delete item.fields.totp_secret;
      totpOmitted.add(item.id);
    }
  }
  return { ...result, totpOmitted };
}
