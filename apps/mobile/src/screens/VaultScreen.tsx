import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { isFileEntry } from '../../../../packages/core/src/files';
import { illustrations } from '../../../../packages/ui/src/native';
import ItemRow from '../components/ItemRow';
import { InputControl } from '../components/Field';
import { AppButton, BottomSheet, EmptyState, FilterChip, Group, Rule, SearchTrigger, SettingsRow } from '../components/mobile-ui';
import { Avatar, Cover, CoverIconButton, FilterGlyph, SortLine, ledgerLetter } from '../components/ledger';
import { useMobileTheme } from '../theme';
import { radius, size, space, textStyle } from '../ui/tokens';
import { exampleItems, isExampleItem } from '../utils/exampleData';
import { isArchived } from '../utils/itemMeta';
import {
  activeFilterCount, clearVaultFilters, filterVaultItems, toggleFilterValue, vaultFacetCounts, vaultFilterPredicate, type VaultFilter, type VaultSort,
} from '../utils/vaultFilter';
import { normalizeVaultQuery } from '../utils/vaultSearch';

export type { VaultFilter, VaultSort } from '../utils/vaultFilter';

type VaultScreenProps = {
  items: VaultItem[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onLoadExamples: (items: VaultItem[]) => void;
  onClearExamples: () => void;
  onSearch?: () => void;
  onOpen?: (screen: 'Shares' | 'Family') => void;
  onViewArchive?: () => void;
  onViewTrash: () => void;
  filter: VaultFilter;
  onFilterChange: (filter: VaultFilter) => void;
  mode?: 'vault' | 'archive';
  title: string;
  accountEmail?: string;
  onAccount?: () => void;
  onBack?: () => void;
};

type FilterOption = { value: string; label: string; count: number; checked: boolean; toggle: () => void };
type FilterSection = { title: string; key: string; data: FilterOption[]; selected: number };

const SEARCHABLE_TAG_LIMIT = 12;

/** One scope chip is a simple scope; anything richer shows removable tokens instead. */
function scopeOf(filter: VaultFilter): 'all' | 'favorites' | ItemType | undefined {
  if (filter.tags.size || filter.collectionIds.size || filter.types.size > 1) return undefined;
  const [type] = [...filter.types];
  if (!type) return filter.scope;
  return filter.scope === 'all' ? type : undefined;
}

export default function VaultScreen({
  items, onSelect, onNew, onLoadExamples, onClearExamples, onSearch, onOpen,
  onViewArchive, onViewTrash, filter, onFilterChange, mode = 'vault', title, accountEmail = '', onAccount, onBack,
}: VaultScreenProps) {
  const { colors, styles } = useMobileTheme();
  const { dict, t, tp, locale } = useTranslation();
  const labels = dict.mobileVault;
  const [draft, setDraft] = useState<VaultFilter>();
  const [optionQuery, setOptionQuery] = useState('');
  const [utility, setUtility] = useState<'sort' | 'more'>();
  const archived = mode === 'archive';
  const candidates = useMemo(() => items.filter((item) => !item.deleted_at && !isFileEntry(item) && isArchived(item) === archived), [items, archived]);
  const visible = useMemo(() => filterVaultItems(candidates, filter, locale, items), [candidates, filter, locale, items]);
  const collections = useMemo(() => items.filter((item) => !item.deleted_at && !isFileEntry(item) && item.type === 'collection')
    .sort((a, b) => a.title.localeCompare(b.title, locale)), [items, locale]);
  const scopeCounts = useMemo(() => vaultFacetCounts(candidates, clearVaultFilters(filter), [], items), [candidates, filter, items]);
  const facets = useMemo(() => draft && vaultFacetCounts(candidates, draft, collections.map((item) => item.id), items), [candidates, draft, collections, items]);
  const optionCount = useMemo(() => new Set(candidates.flatMap((item) => item.tags ?? [])).size + collections.length, [candidates, collections]);
  const hasExamples = items.some(isExampleItem);
  const count = activeFilterCount(filter);
  const scope = scopeOf(filter);
  const pendingCount = useMemo(() => draft ? candidates.filter(vaultFilterPredicate(draft, items)).length : 0, [candidates, draft, items]);
  const letters = useMemo(() => {
    if (filter.sort !== 'titleAsc') return undefined;
    let previous = '';
    return visible.map((item) => {
      const letter = ledgerLetter(item.title, locale);
      const shown = letter === previous ? null : letter;
      previous = letter;
      return shown;
    });
  }, [visible, filter.sort, locale]);

  function openFilters() {
    setOptionQuery('');
    setDraft(filter);
  }

  const sorts: Array<{ value: VaultSort; label: string }> = [
    { value: 'titleAsc', label: dict.shell.sortTitle },
    { value: 'updatedDesc', label: dict.shell.sortUpdated },
    { value: 'createdDesc', label: dict.shell.sortCreated },
  ];
  const typeName = (type: ItemType) => labels.typePlural[type] ?? dict.itemTypes[type];
  const sections = useMemo<FilterSection[]>(() => {
    if (!draft || !facets) return [];
    const sections: FilterSection[] = [];
    const query = normalizeVaultQuery(optionQuery);
    const matches = (label: string) => normalizeVaultQuery(label).includes(query);
    sections.push({
      key: 'type',
      title: labels.type,
      selected: draft.types.size,
      data: (Object.keys(labels.typePlural) as ItemType[]).map((value) => ({
        value, label: typeName(value), count: facets.types.get(value) ?? 0, checked: draft.types.has(value),
        toggle: () => setDraft({ ...draft, types: toggleFilterValue(draft.types, value) }),
      })),
    });
    const tags = [...new Set([...candidates.flatMap((item) => item.tags ?? []), ...draft.tags])].sort((a, b) => a.localeCompare(b, locale));
    if (tags.length) sections.push({
      key: 'tags',
      title: labels.tags,
      selected: draft.tags.size,
      data: tags.filter(matches).map((value) => ({
        value, label: `#${value}`, count: facets.tags.get(value) ?? 0, checked: draft.tags.has(value),
        toggle: () => setDraft({ ...draft, tags: toggleFilterValue(draft.tags, value) }),
      })),
    });
    if (collections.length) sections.push({
      key: 'collections',
      title: labels.collections,
      selected: draft.collectionIds.size,
      data: collections.filter((item) => matches(item.title)).map((item) => ({
        value: item.id, label: item.title, count: facets.collections.get(item.id) ?? 0, checked: draft.collectionIds.has(item.id),
        toggle: () => setDraft({ ...draft, collectionIds: toggleFilterValue(draft.collectionIds, item.id) }),
      })),
    });
    return sections;
  }, [draft, facets, candidates, collections, optionQuery, labels, dict, locale]);

  const clear = () => onFilterChange(clearVaultFilters(filter));
  const pickScope = (next: 'all' | 'favorites' | ItemType) => onFilterChange({
    ...clearVaultFilters(filter),
    scope: next === 'favorites' ? 'favorites' : 'all',
    types: next === 'all' || next === 'favorites' ? new Set() : new Set([next]),
  });
  const presentTypes = (Object.keys(labels.typePlural) as ItemType[]).filter((type) => scopeCounts.types.get(type));
  const filterTrigger = <Pressable testID="vault-filter" accessibilityRole="button" onPress={openFilters}
    accessibilityLabel={scope ? labels.filter : tp(labels.filtersActive, count)}
    style={({ pressed }) => [local.filterButton, {
      backgroundColor: scope ? (pressed ? colors.selection : colors.coverChip) : colors.coverChipSelected,
      borderColor: scope ? colors.coverChipEdge : colors.coverChipSelected,
    }]}>
    <FilterGlyph color={scope ? colors.onCover : colors.onCoverChipSelected} />
    {!scope && <Text style={[textStyle.micro, local.filterBadge, { backgroundColor: colors.cover, color: colors.onCover, borderColor: colors.coverChipSelected }]}>{count}</Text>}
  </Pressable>;

  const chips = scope ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={local.chipScroll} contentContainerStyle={local.chipRow}>
    <FilterChip tone="cover" label={labels.all} facet={scopeCounts.all} testID="vault-scope-all" selected={scope === 'all'} onPress={() => pickScope('all')} />
    <FilterChip tone="cover" label={dict.shell.favorites} facet={scopeCounts.favorites} testID="vault-scope-favorites" selected={scope === 'favorites'} onPress={() => pickScope('favorites')} />
    {presentTypes.map((type) => <FilterChip key={type} tone="cover" label={typeName(type)} facet={scopeCounts.types.get(type)} testID={`vault-scope-${type}`}
      selected={scope === type} onPress={() => pickScope(type)} />)}
  </ScrollView> : <ScrollView horizontal showsHorizontalScrollIndicator={false} style={local.chipScroll} contentContainerStyle={local.chipRow}>
    {filter.scope === 'favorites' && <FilterChip tone="cover" label={dict.shell.favorites} testID="vault-remove-favorites" selected
      onRemove={() => onFilterChange({ ...filter, scope: 'all' })} />}
    {[...filter.types].map((value) => <FilterChip key={`type-${value}`} tone="cover" label={dict.itemTypes[value]} testID={`vault-remove-type-${value}`}
      selected onRemove={() => onFilterChange({ ...filter, types: toggleFilterValue(filter.types, value) })} />)}
    {[...filter.tags].map((value) => <FilterChip key={`tag-${value}`} tone="cover" label={`#${value}`} testID={`vault-remove-tag-${value}`}
      selected onRemove={() => onFilterChange({ ...filter, tags: toggleFilterValue(filter.tags, value) })} />)}
    {[...filter.collectionIds].map((value) => <FilterChip key={`collection-${value}`} tone="cover" label={collections.find((item) => item.id === value)?.title ?? labels.collections}
      testID={`vault-remove-collection-${value}`} selected onRemove={() => onFilterChange({ ...filter, collectionIds: toggleFilterValue(filter.collectionIds, value) })} />)}
    <Pressable testID="vault-clear-all" accessibilityRole="button" onPress={clear} style={local.clearAll}>
      <Text style={[textStyle.control, local.underline, { color: colors.onCover }]}>{labels.clearAll}</Text>
    </Pressable>
  </ScrollView>;

  const cover = <Cover title={title}
    leading={archived ? onBack && <CoverIconButton icon="back" label={dict.common.back} onPress={onBack} testID="archive-back" />
      : onAccount && <Avatar email={accountEmail} onPress={onAccount} />}
    trailing={<>
      <CoverIconButton icon="more" label={t('mobileUI.vaultActions')} onPress={() => setUtility('more')} testID="vault-more" />
      {!archived && <CoverIconButton icon="add" label={t('mobileUI.newItem')} onPress={onNew} testID="new-item-button" />}
    </>}>
    {onSearch && <SearchTrigger onPress={onSearch} />}
    <View style={local.chipBar}>
      {chips}
      {filterTrigger}
    </View>
  </Cover>;

  const emptyTitle = candidates.length ? labels.noMatches : archived ? labels.archivedEmpty : dict.shell.empty.allTitle;
  const emptyDetail = candidates.length ? labels.noMatchesBody : archived ? undefined : dict.mobile.emptyAllBody;
  const openMore = (action: () => void) => { setUtility(undefined); action(); };
  const sortLabel = sorts.find((option) => option.value === filter.sort)?.label;

  return <View style={[local.flex, { backgroundColor: colors.canvas }]}>
    {cover}
    <FlatList data={visible} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      style={local.flex} contentContainerStyle={local.results}
      ListHeaderComponent={<SortLine count={count ? tp(labels.ofCount, visible.length, candidates.length) : tp(labels.itemCount, visible.length)}
        sortLabel={sortLabel} onSort={() => setUtility('sort')} />}
      renderItem={({ item, index }) => <ItemRow item={item} letter={letters ? letters[index] : undefined} onPress={() => onSelect(item.id)} />}
      ListEmptyComponent={<EmptyState image={count ? illustrations.noResults : illustrations.emptyVault} title={emptyTitle} detail={emptyDetail}>
        {count > 0 && <AppButton testID="vault-clear-filters" label={labels.clear} variant="secondary" onPress={clear} />}
        {!candidates.length && !archived && <AppButton testID="empty-new-item" icon="add" label={t('mobileUI.newItem')} onPress={onNew} />}
      </EmptyState>}
    />
    <BottomSheet visible={draft !== undefined} title={labels.filterTitle} onClose={() => setDraft(undefined)} testID="vault-filter-sheet"
      footer={draft && <View style={local.sheetActions}>
        <AppButton testID="vault-filter-reset" label={labels.reset} variant="text" size="compact" onPress={() => { setDraft(clearVaultFilters(draft)); setOptionQuery(''); }} />
        <AppButton testID="vault-filter-apply" label={t('mobileVault.showItems', tp(labels.itemCount, pendingCount))} style={local.flex}
          onPress={() => { onFilterChange(draft); setDraft(undefined); }} />
      </View>}>
      {draft && facets && <>
        <Text accessibilityRole="header" style={[textStyle.strong, local.filterHeading, { color: colors.text }]}>{labels.show}</Text>
        <View style={local.cloud}>
          <FilterChip label={labels.allItems} testID="vault-filter-scope-all" selected={draft.scope === 'all'} onPress={() => setDraft({ ...draft, scope: 'all' })} />
          <FilterChip label={dict.shell.favorites} facet={facets.favorites} testID="vault-filter-scope-favorites" selected={draft.scope === 'favorites'}
            onPress={() => setDraft({ ...draft, scope: 'favorites' })} />
        </View>
        {optionCount > SEARCHABLE_TAG_LIMIT && <InputControl testID="vault-filter-search" boxed
          accessibilityLabel={labels.searchOptions} placeholder={labels.searchOptions} value={optionQuery} onChangeText={setOptionQuery}
          autoCapitalize="none" autoCorrect={false} containerStyle={local.filterSearch} />}
        {sections.map((section) => <View key={section.key}>
          <View style={local.filterHeadingRow}>
            <Text accessibilityRole="header" style={[textStyle.strong, local.flex, { color: colors.text }]}>{section.title}</Text>
            {section.selected > 0 && <Text style={[textStyle.caption, { color: colors.secondaryText }]}>{t('mobileVault.selectedCount', section.selected)}</Text>}
          </View>
          <View style={local.cloud}>
            {section.data.map((option) => <FilterChip key={option.value} label={option.label} facet={option.count}
              testID={`vault-filter-${section.key}-${option.value}`} selected={option.checked} onPress={option.toggle} />)}
          </View>
        </View>)}
      </>}
    </BottomSheet>
    <BottomSheet compact visible={utility === 'sort'} title={t('mobileUI.sort')} testID="vault-sort-sheet" onClose={() => setUtility(undefined)}>
      <Group>{sorts.map((option, index) => <React.Fragment key={option.value}>
        {index > 0 && <Rule />}
        <SettingsRow testID={`vault-sort-${option.value}`} label={option.label}
          selected={filter.sort === option.value} accessibilityRole="radio" accessibilityState={{ checked: filter.sort === option.value }}
          onPress={() => { onFilterChange({ ...filter, sort: option.value }); setUtility(undefined); }} />
      </React.Fragment>)}</Group>
    </BottomSheet>
    <BottomSheet compact visible={utility === 'more'} title={t('mobileUI.vaultActions')} testID="vault-utilities" onClose={() => setUtility(undefined)}>
      <Group>
        {onViewArchive && <>
          <SettingsRow label={dict.shell.archived} icon="archive" navigation testID="vault-open-archive" onPress={() => openMore(onViewArchive)} />
          <Rule leading />
        </>}
        <SettingsRow label={dict.shell.trash} icon="trash" navigation testID="vault-open-trash" onPress={() => openMore(onViewTrash)} />
        {onOpen && <>
          <Rule leading />
          <SettingsRow label={dict.shell.sharing} icon="share" navigation onPress={() => openMore(() => onOpen('Shares'))} />
          <Rule leading />
          <SettingsRow label={dict.family.title} icon="members" navigation onPress={() => openMore(() => onOpen('Family'))} />
        </>}
        {!archived && <>
          <Rule leading />
          <SettingsRow label={hasExamples ? dict.mobileUI.clearExamples : dict.mobileUI.loadExamples} icon="items"
            testID="vault-example-action" onPress={() => openMore(() => hasExamples ? onClearExamples() : onLoadExamples(exampleItems()))} />
        </>}
      </Group>
    </BottomSheet>
  </View>;
}

const local = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  chipBar: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  chipScroll: { flex: 1, marginLeft: -space[4], flexGrow: 1 },
  chipRow: { gap: space[2], paddingLeft: space[4], paddingRight: space[2], alignItems: 'center' },
  filterButton: { width: size.chip, height: size.chip, borderRadius: radius.chip, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  filterBadge: { position: 'absolute', top: -space[2], right: -space[1], minWidth: space[5] + 2, minHeight: space[5] + 2, borderRadius: radius.full,
    borderWidth: 2, textAlign: 'center', overflow: 'hidden', paddingHorizontal: space[1] },
  clearAll: { minHeight: size.chip, justifyContent: 'center', paddingHorizontal: space[2] },
  underline: { textDecorationLine: 'underline' },
  results: { paddingBottom: space[6] },
  sheetActions: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  filterHeading: { paddingTop: space[2], marginBottom: space[3] },
  filterHeadingRow: { flexDirection: 'row', alignItems: 'center', paddingTop: space[5], marginBottom: space[3] },
  cloud: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  filterSearch: { marginTop: space[4] },
});
