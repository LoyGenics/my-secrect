import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { cardIssuer } from '../../../../packages/core/src/card';
import { isArchived } from './itemMeta';
import { createVaultFilter, vaultComparator, vaultFilterPredicate, type VaultFilter } from './vaultFilter';

const SEARCH_METADATA: Partial<Record<ItemType, readonly string[]>> = {
  login: ['service'],
  bank_account: ['bank_name', 'holder_name', 'branch', 'currency'],
  card: ['bank', 'brand', 'cardholder', 'card_type'],
  identity: ['full_name', 'document_type'],
  api_key: ['service'],
  document: ['file_name', 'mime_type'],
  media: ['file_name', 'mime_type'],
};

export function normalizeVaultQuery(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').trim();
}

/** Host only. URL user info, path segments, query strings and fragments may carry secrets. */
function hostOf(value: string): string {
  const withoutScheme = value.trim().replace(/^https?:\/\//i, '');
  const authority = withoutScheme.split(/[/?#]/, 1)[0];
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/, '');
  return /^[a-z\d.\-]+$/i.test(host) ? host.toLowerCase() : '';
}

interface SearchEntry {
  item: VaultItem;
  fields: ReadonlyArray<readonly string[]>;
}

function text(item: VaultItem, field: string): string {
  const value = item.fields[field];
  return typeof value === 'string' ? value : '';
}

export function indexVaultSearch(items: readonly VaultItem[], archived = false): SearchEntry[] {
  return items.filter((item) => !item.deleted_at && isArchived(item) === archived).map((item) => {
    const title = item.type === 'card' ? cardIssuer(item.title, item.fields.bank) : item.title;
    const site = item.type === 'login' ? hostOf(text(item, 'url')) : item.type === 'passkey' ? hostOf(text(item, 'rp_id')) : '';
    return {
      item,
      fields: [
        title === item.title ? [title] : [item.title, title],
        [site],
        item.type === 'login' ? [text(item, 'username')] : [],
        item.tags ?? [],
        (SEARCH_METADATA[item.type] ?? []).map((key) => text(item, key)),
      ].map((group) => group.map(normalizeVaultQuery).filter(Boolean)),
    };
  });
}

function termRank(fields: SearchEntry['fields'], term: string): number {
  for (const [index, values] of fields.entries()) {
    if (values.includes(term)) return index * 3;
    if (values.some((value) => value.startsWith(term))) return index * 3 + 1;
    if (values.some((value) => value.includes(term))) return index * 3 + 2;
  }
  return -1;
}

export function searchVaultIndex(
  index: readonly SearchEntry[], items: readonly VaultItem[], query: string, filter: VaultFilter = createVaultFilter(), locale?: string,
): VaultItem[] {
  const normalized = normalizeVaultQuery(/^https?:\/\//i.test(query.trim()) ? hostOf(query) || query : query);
  const predicate = vaultFilterPredicate(filter, items);
  if (!normalized) {
    return index.filter(({ item }) => predicate(item)).map(({ item }) => item).sort(vaultComparator('updatedDesc', locale)).slice(0, 8);
  }
  const terms = [...new Set(normalized.split(/\s+/))];
  const matches: Array<{ item: VaultItem; exactTitle: boolean; score: number }> = [];
  for (const { item, fields } of index) {
    if (!predicate(item)) continue;
    const ranks = terms.map((term) => termRank(fields, term));
    if (ranks.includes(-1)) continue;
    matches.push({ item, exactTitle: fields[0].includes(normalized), score: ranks.reduce((sum, rank) => sum + rank, 0) });
  }
  const compare = vaultComparator(filter.sort, locale);
  return matches
    .sort((a, b) => Number(b.exactTitle) - Number(a.exactTitle) || a.score - b.score || compare(a.item, b.item))
    .map(({ item }) => item);
}
