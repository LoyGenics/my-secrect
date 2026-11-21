import type { ItemType, VaultItem } from '../../../../packages/core/src/types';

export type VaultScope = 'all' | 'favorites';
export type VaultSort = 'updatedDesc' | 'titleAsc' | 'createdDesc';

export interface VaultFilter {
  scope: VaultScope;
  types: ReadonlySet<ItemType>;
  tags: ReadonlySet<string>;
  collectionIds: ReadonlySet<string>;
  sort: VaultSort;
}

/** The ledger opens on Title A–Z; Recently updated is one tap away in Sort. */
export function createVaultFilter(): VaultFilter {
  return { scope: 'all', types: new Set(), tags: new Set(), collectionIds: new Set(), sort: 'titleAsc' };
}

export function clearVaultFilters(filter: VaultFilter): VaultFilter {
  return { ...createVaultFilter(), sort: filter.sort };
}

export function activeFilterCount(filter: VaultFilter): number {
  return Number(filter.scope === 'favorites') + filter.types.size + filter.tags.size + filter.collectionIds.size;
}

export function toggleFilterValue<T>(values: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function vaultComparator(sort: VaultSort, locale?: string): (a: VaultItem, b: VaultItem) => number {
  const compareTitle = new Intl.Collator(locale, { sensitivity: 'base', numeric: true }).compare;
  return (a, b) => {
    const order = sort === 'titleAsc'
      ? compareTitle(a.title, b.title)
      : Date.parse(sort === 'createdDesc' ? b.created_at : b.updated_at) - Date.parse(sort === 'createdDesc' ? a.created_at : a.updated_at);
    return order || compareTitle(a.title, b.title) || a.id.localeCompare(b.id);
  };
}

function parentOf(item: VaultItem): string | undefined {
  return typeof item.fields.parent_id === 'string' ? item.fields.parent_id : undefined;
}

/** Encrypted parent links and explicit collection membership, with cycle protection. */
export function collectionMatches(items: readonly VaultItem[], ids: ReadonlySet<string>): (item: VaultItem) => boolean {
  if (!ids.size) return () => true;
  const collections = new Map(items.filter((item) => !item.deleted_at && item.type === 'collection').map((item) => [item.id, item]));
  const inherited = new Map<string, boolean>();
  const relatedContents = new Set<string>();
  for (const collection of collections.values()) {
    if (!ids.has(collection.id)) continue;
    for (const relation of collection.relations ?? []) {
      if (relation.type === 'contains') relatedContents.add(relation.target_id);
    }
  }
  function matchesParent(parent: string | undefined): boolean {
    const visited = new Set<string>();
    let match = false;
    while (parent && !visited.has(parent)) {
      if (ids.has(parent)) { match = true; break; }
      const prior = inherited.get(parent);
      if (prior !== undefined) { match = prior; break; }
      visited.add(parent);
      const collection = collections.get(parent);
      parent = collection && parentOf(collection);
    }
    for (const id of visited) inherited.set(id, match);
    return match;
  }
  return (item) => relatedContents.has(item.id)
    || matchesParent(parentOf(item))
    || (item.relations ?? []).some((relation) => relation.type === 'belongs_to' && matchesParent(relation.target_id));
}

export function vaultFilterPredicate(filter: VaultFilter, allItems: readonly VaultItem[]): (item: VaultItem) => boolean {
  const matchesCollection = collectionMatches(allItems, filter.collectionIds);
  return (item) => !item.deleted_at
    && (filter.scope === 'all' || item.favorite === true)
    && (!filter.types.size || filter.types.has(item.type))
    && (!filter.tags.size || (item.tags ?? []).some((tag) => filter.tags.has(tag)))
    && matchesCollection(item);
}

export function filterVaultItems(
  items: readonly VaultItem[], filter: VaultFilter, locale?: string, collectionContext: readonly VaultItem[] = items,
): VaultItem[] {
  return items.filter(vaultFilterPredicate(filter, collectionContext)).sort(vaultComparator(filter.sort, locale));
}

export interface VaultFacetCounts {
  all: number;
  favorites: number;
  types: Map<ItemType, number>;
  tags: Map<string, number>;
  collections: Map<string, number>;
}

/**
 * Honest faceted counts: each value counts the items that would match if it
 * were the only choice in its own group, with every other group applied.
 */
export function vaultFacetCounts(
  items: readonly VaultItem[], filter: VaultFilter, collectionIds: readonly string[] = [], allItems: readonly VaultItem[] = items,
): VaultFacetCounts {
  const counts: VaultFacetCounts = { all: 0, favorites: 0, types: new Map(), tags: new Map(), collections: new Map() };
  const add = <T>(map: Map<T, number>, key: T) => map.set(key, (map.get(key) ?? 0) + 1);
  const withoutScope = vaultFilterPredicate({ ...filter, scope: 'all' }, allItems);
  const withoutTypes = vaultFilterPredicate({ ...filter, types: new Set() }, allItems);
  const withoutTags = vaultFilterPredicate({ ...filter, tags: new Set() }, allItems);
  const withoutCollections = vaultFilterPredicate({ ...filter, collectionIds: new Set() }, allItems);
  const inCollection = collectionIds.map((id) => [id, collectionMatches(allItems, new Set([id]))] as const);
  for (const item of items) {
    if (withoutScope(item)) {
      counts.all += 1;
      if (item.favorite === true) counts.favorites += 1;
    }
    if (withoutTypes(item)) add(counts.types, item.type);
    if (withoutTags(item)) for (const tag of new Set(item.tags ?? [])) add(counts.tags, tag);
    if (withoutCollections(item)) for (const [id, matches] of inCollection) if (matches(item)) add(counts.collections, id);
  }
  return counts;
}
