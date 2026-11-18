import { CARD_TYPES, cardInputError, prepareCardFields } from '../../../../packages/core/src/card';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { FORBIDDEN_FIELDS, ITEM_SCHEMAS } from '../../../../packages/schemas/src/item-types';
import { appendNoteRevision, appendPasswordHistory, getNoteRevisions, getPasswordHistory } from './itemMeta';
import { isValidBase32Secret } from './totp';

export const CUSTOM_FIELD_META = 'custom_field_meta_v1';
export const CUSTOM_FIELD_KINDS = ['text', 'secret', 'multiline', 'date', 'url'] as const;
export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number];

export interface CustomEditorField {
  key: string;
  label: string;
  kind: CustomFieldKind;
  value: unknown;
  typed: boolean;
}

const COMPATIBLE_FIELDS: Partial<Record<ItemType, readonly string[]>> = {
  login: ['service'],
  identity: ['document_type'],
  ssh_key: ['private_key'],
  secure_note: ['notes'],
  document: ['file_name', 'size', 'sha256', 'parent_id'],
  media: ['file_name', 'size', 'sha256', 'parent_id'],
  collection: ['url', 'notes', 'parent_id', 'collection_kind'],
  custom: ['description', 'notes'],
};

const TEMPLATE_FIELDS = Object.fromEntries(
  (Object.keys(ITEM_SCHEMAS) as ItemType[]).map((type) => [
    type,
    new Set<string>([...ITEM_SCHEMAS[type].required, ...ITEM_SCHEMAS[type].optional, ...(COMPATIBLE_FIELDS[type] ?? [])]),
  ]),
) as unknown as Record<ItemType, ReadonlySet<string>>;

const RESERVED = new Set(Object.values(TEMPLATE_FIELDS).flatMap((fields) => [...fields]));
const SYSTEM = new Set(['archived', 'password_history', 'revisions', CUSTOM_FIELD_META]);
const FORBIDDEN = new Set(FORBIDDEN_FIELDS);

function forbiddenField(key: string): boolean { return FORBIDDEN.has(key.toLowerCase()); }

function isSecretField(key: string): boolean {
  return /password|secret|(?:^|_)private_key|^key$|account_number|card_number|document_number/i.test(key);
}

/** Typed metadata is a JSON string so older editors preserve it alongside string values. */
function typedDefinitions(value: unknown): Omit<CustomEditorField, 'value'>[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as { version?: unknown; fields?: unknown } | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.fields)) return [];
    const keys = new Set<string>();
    const definitions: Omit<CustomEditorField, 'value'>[] = [];
    for (const candidate of parsed.fields as Array<(Partial<CustomEditorField> & { legacy?: boolean }) | null>) {
      const { key, label, kind, legacy } = candidate ?? {};
      if (typeof key !== 'string' || typeof label !== 'string' || !label.trim()
        || kind === undefined || !CUSTOM_FIELD_KINDS.includes(kind) || keys.has(key)) continue;
      const prefix = kind === 'secret' ? 'secret_custom_' : 'custom_';
      if (legacy ? SYSTEM.has(key) || forbiddenField(key) : !key.startsWith(prefix) || !/^[a-z\d_]+$/.test(key)) continue;
      keys.add(key);
      definitions.push({ key, label, kind: legacy && isSecretField(key) ? 'secret' : kind, typed: !legacy });
    }
    return definitions;
  } catch {
    return [];
  }
}

export function readCustomFields(item: Pick<VaultItem, 'type' | 'fields'>): CustomEditorField[] {
  const definitions = typedDefinitions(item.fields[CUSTOM_FIELD_META]).filter(({ key, typed }) =>
    typed || (!TEMPLATE_FIELDS[item.type].has(key) && (item.type === 'custom' || !RESERVED.has(key))));
  const defined = new Set(definitions.map((field) => field.key));
  const typed = definitions.map((field) => ({ ...field, value: Object.prototype.hasOwnProperty.call(item.fields, field.key) ? item.fields[field.key] : undefined }));
  const legacy = Object.entries(item.fields).filter(([key]) => !defined.has(key) && !SYSTEM.has(key)
    && !forbiddenField(key) && !TEMPLATE_FIELDS[item.type].has(key) && (item.type === 'custom' || !RESERVED.has(key)));
  return typed.concat(legacy.map(([key, value]) => ({
    key, label: key, value, kind: isSecretField(key) ? 'secret' : 'text', typed: false,
  })));
}

export function customFieldKey(id: string, kind: CustomFieldKind): string {
  return `${kind === 'secret' ? 'secret_' : ''}custom_${id}`;
}

/** Includes pre-existing incompatible template values so a save can warn before dropping them. */
export function readTemplateFields(item?: VaultItem): Record<string, unknown> {
  if (!item) return {};
  const custom = new Set(readCustomFields(item).map((field) => field.key));
  return Object.fromEntries(Object.entries(item.fields).filter(([key]) => !custom.has(key) && !SYSTEM.has(key) && !forbiddenField(key)));
}

const EXACT_VALUE_FIELDS = new Set(['password', 'key', 'private_key', 'body', 'public_key']);
function present(value: unknown, preserveSpaces = false): boolean {
  if (typeof value === 'string') return !!(preserveSpaces ? value : value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function canKeepCustom(field: CustomEditorField, initialType: ItemType, target: ItemType): boolean {
  return !forbiddenField(field.key) && !SYSTEM.has(field.key) && !TEMPLATE_FIELDS[target].has(field.key)
    && (field.typed || initialType === target || !RESERVED.has(field.key));
}

export function incompatibleFieldLabels(
  target: ItemType, source: ItemType, fields: Record<string, unknown>, custom: readonly CustomEditorField[], initial?: VaultItem, hasLocalCardCode = false,
): string[] {
  const names = Object.entries(fields)
    .filter(([key, value]) => !TEMPLATE_FIELDS[target].has(key) && present(value, EXACT_VALUE_FIELDS.has(key)))
    .map(([key]) => key);
  names.push(...custom.filter((field) => !canKeepCustom(field, source, target) && present(field.value, field.kind === 'secret')).map((field) => field.label));
  if (initial?.type === 'login' && target !== 'login' && getPasswordHistory(initial).length) names.push('password_history');
  if (initial?.type === 'secure_note' && target !== 'secure_note' && getNoteRevisions(initial).length) names.push('revisions');
  if (source === 'card' && target !== 'card' && hasLocalCardCode) names.push('cvv');
  return [...new Set(names)];
}

export function reclassifyDraft(target: ItemType, source: ItemType, fields: Record<string, unknown>, custom: readonly CustomEditorField[]) {
  return {
    fields: Object.fromEntries(Object.entries(fields).filter(([key]) => TEMPLATE_FIELDS[target].has(key))),
    custom: custom.filter((field) => canKeepCustom(field, source, target)),
  };
}

/** Builds the ordinary vault payload. Local CVV is deliberately absent from this API. */
export function serializeEditorFields(
  type: ItemType, draft: Record<string, unknown>, custom: readonly CustomEditorField[], initial: VaultItem | undefined, now: string,
): Record<string, unknown> {
  const allowed = TEMPLATE_FIELDS[type];
  const fields = Object.fromEntries(Object.entries(draft).filter(([key, value]) => allowed.has(key) && !forbiddenField(key) && present(value, EXACT_VALUE_FIELDS.has(key)))
    .map(([key, value]) => {
      if (typeof value !== 'string' || EXACT_VALUE_FIELDS.has(key)) return [key, value];
      if (type === 'login' && key === 'url') return [key, normalizeWebsite(value)?.url ?? value.trim()];
      if (type === 'card' && key === 'expiry') return [key, normalizeCardExpiry(value) ?? value.trim()];
      if (key === 'currency') return [key, value.trim().toUpperCase()];
      return [key, value.trim()];
    }));
  if (type === 'card') prepareCardFields(fields);
  if (initial?.fields.archived === true) fields.archived = true;
  if (type === 'login' && initial?.type === 'login') {
    const history = getPasswordHistory(initial);
    const previous = initial.fields.password;
    const password = fields.password;
    const saved = typeof previous === 'string' && typeof password === 'string' && previous !== password
      ? appendPasswordHistory(history, previous, now) : history;
    if (saved.length) fields.password_history = saved;
  }
  if (type === 'secure_note' && initial?.type === 'secure_note') {
    const revisions = getNoteRevisions(initial);
    const previous = initial.fields.body;
    const body = fields.body;
    const saved = typeof previous === 'string' && typeof body === 'string' && previous !== body
      ? appendNoteRevision(revisions, previous, now) : revisions;
    if (saved.length) fields.revisions = saved;
  }
  const metadata: Array<{ key: string; label: string; kind: CustomFieldKind; legacy?: true }> = [];
  for (const field of custom) {
    if (!canKeepCustom(field, initial?.type ?? type, type)) continue;
    if (field.value !== undefined) Object.defineProperty(fields, field.key, { value: field.value, enumerable: true, writable: true });
    metadata.push({ key: field.key, label: field.label, kind: field.kind, ...(field.typed ? {} : { legacy: true }) });
  }
  if (metadata.some((field) => !field.legacy)) fields[CUSTOM_FIELD_META] = JSON.stringify({ version: 1, fields: metadata });
  else if (initial?.type === type && typeof initial.fields[CUSTOM_FIELD_META] === 'string' && !typedDefinitions(initial.fields[CUSTOM_FIELD_META]).length) {
    fields[CUSTOM_FIELD_META] = initial.fields[CUSTOM_FIELD_META];
  }
  return fields;
}

export function editorDraftSignature(draft: {
  type: ItemType; title: string; fields: Record<string, unknown>; customFields: readonly CustomEditorField[];
  tags: readonly string[]; relationIds: readonly string[]; favorite: boolean; cardCodeEdited: boolean;
}): string {
  return JSON.stringify({ ...draft, fields: Object.fromEntries(Object.entries(draft.fields).sort(([a], [b]) => a.localeCompare(b))) });
}

export function normalizeWebsite(value: string): { url: string; host: string } | undefined {
  const input = value.trim();
  if (!input || /[\s\\\u0000-\u001f]/.test(input)) return undefined;
  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const url = hasProtocol ? input : `https://${input}`;
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url)?.[1];
  if (!authority || authority.includes('@')) return undefined;
  const match = /^(\[[a-f\d:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65_535))) return undefined;
  const host = match[1];
  // React Native 0.76's built-in URL throws for .hostname and .protocol.
  if (host.startsWith('[')) {
    if (!host.includes(':')) return undefined;
  } else {
    const labels = host.replace(/\.$/, '').split('.');
    if (!labels.every(label => /^[\w\p{L}\p{N}](?:[\w\p{L}\p{N}-]*[\w\p{L}\p{N}])?$/u.test(label))) return undefined;
    if (labels.length < 2 && host.toLowerCase() !== 'localhost') return undefined;
  }
  return { url, host };
}

export function normalizeCardExpiry(value: string): string | undefined {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(trimmed);
  if (iso) return `${iso[2]}/${iso[1].slice(2)}`;
  const date = /^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/.exec(trimmed);
  if (date) return `${date[1]}/${date[2].slice(-2)}`;
  return undefined;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseEditorDate(value: string): { year: number; month: number; day: number } | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return undefined;
  const [, year, month, day] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

export function formatEditorDate(year: number, month: number, day: number): string {
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

export type EditorIssue = 'required' | 'url' | 'totp' | 'cardNumber' | 'cvv' | 'expiry' | 'statementDay' | 'cardType';

export function getEditorIssues(type: ItemType, fields: Record<string, unknown>, localCardCode?: string, initial?: VaultItem): Record<string, EditorIssue> {
  const issues: Record<string, EditorIssue> = {};
  const value = (key: string) => typeof fields[key] === 'string' ? fields[key] as string : '';
  const changed = (key: string) => initial?.fields[key] !== fields[key];
  if (type === 'login') {
    if (!value('username').trim()) issues.username = 'required';
    if (value('url').trim() && changed('url') && !normalizeWebsite(value('url'))) issues.url = 'url';
    if (value('totp_secret').trim() && changed('totp_secret') && !isValidBase32Secret(value('totp_secret'))) issues.totp_secret = 'totp';
  } else if (type === 'bank_account') {
    if (!value('bank_name').trim()) issues.bank_name = 'required';
  } else if (type === 'card') {
    // Validate only app-controlled card fields and keep older representations readable.
    for (const [key, issue] of [['card_number', 'cardNumber'], ['cvv', 'cvv'], ['statement_day', 'statementDay']] as const) {
      if (key !== 'cvv' && !changed(key)) continue;
      const input: Record<string, string> = key === 'cvv' ? {} : { [key]: value(key), card_type: value('card_type') };
      if (cardInputError(input, key === 'cvv' ? localCardCode ?? '' : '')) issues[key] = issue;
    }
    if (value('expiry').trim() && changed('expiry') && !normalizeCardExpiry(value('expiry'))) issues.expiry = 'expiry';
    if (value('card_type') && changed('card_type') && !CARD_TYPES.some((kind) => kind === value('card_type'))) issues.card_type = 'cardType';
  }
  return issues;
}
