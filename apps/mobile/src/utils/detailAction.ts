import { cardLast4 } from '../../../../packages/core/src/card';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';

export type DetailCopyKey = 'password' | 'username' | 'account_number' | 'last4' | 'document_number'
  | 'key' | 'body' | 'public_key' | 'private_key_ref';
export type DetailAction =
  | { type: 'copy'; key: DetailCopyKey; value: string }
  | { type: 'edit' | 'restore' | 'openCollection' | 'openFile' };

export function detailString(item: Pick<VaultItem, 'fields'>, key: string): string {
  const value = item.fields[key];
  return typeof value === 'string' ? value : '';
}

export function formatDetailFieldsForClipboard(fields: readonly { label: string; value: string; includeInCopyAll?: boolean }[]): string {
  return fields
    .filter(({ value, includeInCopyAll }) => value && includeInCopyAll !== false)
    .map(({ label, value }) => `${label}:${value.includes('\n') ? '\n' : ' '}${value}`)
    .join('\n');
}

const COPY_FIELDS: Partial<Record<ItemType, readonly DetailCopyKey[]>> = {
  login: ['password', 'username'],
  bank_account: ['account_number'],
  identity: ['document_number'],
  api_key: ['key'],
  secure_note: ['body'],
  ssh_key: ['public_key', 'private_key_ref'],
};

export function getPrimaryDetailAction(
  item: Pick<VaultItem, 'type' | 'fields'>,
  { inTrash = false, canOpenCollection = false, canOpenFile = false }: {
    inTrash?: boolean; canOpenCollection?: boolean; canOpenFile?: boolean;
  } = {},
): DetailAction {
  if (inTrash) return { type: 'restore' };
  if (item.type === 'collection' && canOpenCollection) return { type: 'openCollection' };
  if ((item.type === 'document' || item.type === 'media') && canOpenFile) return { type: 'openFile' };
  if (item.type === 'card') {
    const last4 = cardLast4(item.fields);
    return /^\d{4}$/.test(last4) ? { type: 'copy', key: 'last4', value: last4 } : { type: 'edit' };
  }
  for (const key of COPY_FIELDS[item.type] ?? []) {
    const value = detailString(item, key);
    if (value) return { type: 'copy', key, value };
  }
  return { type: 'edit' };
}
