import React, { useMemo, useState } from 'react';
import { FlatList, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import { isFileEntry } from '../../../../packages/core/src/files';
import { illustrations } from '../../../../packages/ui/src/native';
import ItemRow, { typeLabel } from '../components/ItemRow';
import { InputControl } from '../components/Field';
import { AppButton, AppPage, BottomSheet, EmptyState, FilterChip, Group, IconButton, Rule, SearchTrigger, SettingsRow } from '../components/mobile-ui';
import { useMobileTheme } from '../theme';
import { space } from '../ui/tokens';
import { exampleItems, EXAMPLE_IDS } from '../utils/exampleData';
import { isArchived } from '../utils/itemMeta';
import { activeFilterCount, clearVaultFilters, filterVaultItems, toggleFilterValue, vaultFilterPredicate, type VaultFilter, type VaultSort } from '../utils/vaultFilter';
import { normalizeVaultQuery } from '../utils/vaultSearch';

export type { VaultFilter, VaultSort } from '../utils/vaultFilter';

type VaultScreenProps = {
  items: VaultItem[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onNew: () => void;
  onLoadExamples: (items: VaultItem[]) => void;
  onClearExamples: (ids: string[]) => void;
  onSearch?: () => void;
  onOpen?: (screen: 'Shares' | 'Family') => void;
  onViewArchive?: () => void;
  onViewTrash: () => void;
  filter: VaultFilter;
  onFilterChange: (filter: VaultFilter) => void;
  mode?: 'vault' | 'archive';
};

type FilterOption = { value: string; label: string; count?: number; checked: boolean; toggle: () => void };
type FilterSection = { title: string; key: string; data: FilterOption[] };

const SEARCHABLE_TAG_LIMIT = 12;

export default function VaultScreen({
  items, onSelect, onToggleFavorite, onNew, onLoadExamples, onClearExamples, onSearch, onOpen,
  onViewArchive, onViewTrash, filter, onFilterChange, mode = 'vault',
}: VaultScreenProps) {
  const { styles } = useMobileTheme();
  const { dict, t, locale } = useTranslation();
  const labels = dict.mobileVault;
  const [draft, setDraft] = useState<VaultFilter>();
  const [optionQuery, setOptionQuery] = useState('');
  const [utility, setUtility] = useState<'sort' | 'more'>();
  const archived = mode === 'archive';
  const candidates = useMemo(() => items.filter((item) => !item.deleted_at && !isFileEntry(item) && isArchived(item) === archived), [items, archived]);
  const visible = useMemo(() => filterVaultItems(candidates, filter, locale, items), [candidates, filter, locale, items]);
  const options = useMemo(() => {
    const typeCounts = new Map<ItemType, number>();
    const tagCounts = new Map<string, number>();
    for (const item of candidates) {
      typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
      for (const tag of new Set(item.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const collections = items.filter((item) => !item.deleted_at && !isFileEntry(item) && item.type === 'collection')
      .sort((a, b) => a.title.localeCompare(b.title, locale));
    return { typeCounts, tagCounts, collections };
  }, [items, candidates, locale]);
  const hasExamples = items.some((item) => EXAMPLE_IDS.includes(item.id));
  const count = activeFilterCount(filter);
  const pendingCount = useMemo(() => draft ? candidates.filter(vaultFilterPredicate(draft, items)).length : 0, [candidates, draft, items]);

  function openFilters() {
    setOptionQuery('');
    setDraft(filter);
  }

  const sorts: Array<{ value: VaultSort; label: string }> = [
    { value: 'updatedDesc', label: dict.shell.sortUpdated },
    { value: 'titleAsc', label: dict.shell.sortTitle },
    { value: 'createdDesc', label: dict.shell.sortCreated },
  ];
  const sections = useMemo<FilterSection[]>(() => {
    if (!draft) return [];
    const sections: FilterSection[] = [];
    const query = normalizeVaultQuery(optionQuery);
    const matches = (label: string) => normalizeVaultQuery(label).includes(query);
    const types = [...new Set([...options.typeCounts.keys(), ...draft.types])].sort((a, b) => typeLabel(dict, a).localeCompare(typeLabel(dict, b), locale));
    sections.push({
      key: 'type',
      title: labels.type,
      data: types.map((value) => ({
        value, label: typeLabel(dict, value), count: options.typeCounts.get(value) ?? 0, checked: draft.types.has(value),
        toggle: () => setDraft({ ...draft, types: toggleFilterValue(draft.types, value) }),
      })),
    });
    const tags = [...new Set([...options.tagCounts.keys(), ...draft.tags])].sort((a, b) => a.localeCompare(b, locale));
    if (tags.length) sections.push({
      key: 'tags',
      title: labels.tags,
      data: tags.filter(matches).map((value) => ({
        value, label: value, count: options.tagCounts.get(value) ?? 0, checked: draft.tags.has(value),
        toggle: () => setDraft({ ...draft, tags: toggleFilterValue(draft.tags, value) }),
      })),
    });
    if (options.collections.length) sections.push({
      key: 'collections',
      title: labels.collections,
      data: options.collections.filter((item) => matches(item.title)).map((item) => ({
        value: item.id, label: item.title, checked: draft.collectionIds.has(item.id),
        toggle: () => setDraft({ ...draft, collectionIds: toggleFilterValue(draft.collectionIds, item.id) }),
      })),
    });
    return sections;
  }, [draft, options, optionQuery, labels, dict, locale]);

  const clear = () => onFilterChange(clearVaultFilters(filter));
  const header = <View style={local.header}>
    {onSearch && <SearchTrigger onPress={onSearch} />}
    <View style={local.controls}>
      <View style={local.scopes}>
        <FilterChip label={labels.all} testID="vault-scope-all" selected={filter.scope === 'all'} onPress={() => onFilterChange({ ...filter, scope: 'all' })} />
        <FilterChip label={dict.shell.favorites} testID="vault-scope-favorites" selected={filter.scope === 'favorites'} onPress={() => onFilterChange({ ...filter, scope: 'favorites' })} />
      </View>
      <FilterChip label={labels.filter} icon="filter" count={count} testID="vault-filter" onPress={openFilters} />
      <IconButton testID="vault-sort" icon="sort" accessibilityLabel={t('mobileUI.sort')} onPress={() => setUtility('sort')} />
      {!archived && <IconButton testID="vault-more" icon="more" accessibilityLabel={t('mobileUI.vaultActions')} onPress={() => setUtility('more')} />}
    </View>
    {!!(filter.types.size || filter.tags.size || filter.collectionIds.size) && <ScrollView horizontal contentContainerStyle={local.selectedFilters}>
      {[...filter.types].map((value) => <FilterChip key={`type-${value}`} label={typeLabel(dict, value)} testID={`vault-remove-type-${value}`}
        selected onRemove={() => onFilterChange({ ...filter, types: toggleFilterValue(filter.types, value) })} />)}
      {[...filter.tags].map((value) => <FilterChip key={`tag-${value}`} label={`#${value}`} testID={`vault-remove-tag-${value}`}
        selected onRemove={() => onFilterChange({ ...filter, tags: toggleFilterValue(filter.tags, value) })} />)}
      {[...filter.collectionIds].map((value) => <FilterChip key={`collection-${value}`} label={options.collections.find((item) => item.id === value)?.title ?? labels.collections}
        testID={`vault-remove-collection-${value}`} selected onRemove={() => onFilterChange({ ...filter, collectionIds: toggleFilterValue(filter.collectionIds, value) })} />)}
    </ScrollView>}
    <Text testID="vault-result-count" accessibilityLiveRegion="polite" style={styles.small}>{t('mobileUI.itemCount', visible.length)}</Text>
  </View>;
  const emptyTitle = candidates.length ? labels.noMatches : archived ? labels.archivedEmpty : dict.shell.empty.allTitle;
  const emptyDetail = candidates.length ? labels.noMatchesBody : archived ? undefined : dict.mobile.emptyAllBody;
  const openMore = (action: () => void) => { setUtility(undefined); action(); };

  return <AppPage width="list" scroll={false} header={header}>
    <FlatList data={visible} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={local.results}
      renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => onToggleFavorite(item.id)} />}
      ListEmptyComponent={<EmptyState image={count ? illustrations.noResults : illustrations.emptyVault} title={emptyTitle} detail={emptyDetail}>
        {count > 0 && <AppButton testID="vault-clear-filters" label={labels.clear} variant="secondary" onPress={clear} />}
        {!candidates.length && !archived && <AppButton testID="empty-new-item" variant="secondary" icon="add" label={t('mobileUI.newItem')} onPress={onNew} />}
      </EmptyState>}
    />
    <BottomSheet visible={draft !== undefined} title={labels.filterTitle} onClose={() => setDraft(undefined)} testID="vault-filter-sheet" scroll={false}
      footer={draft && <>
        <AppButton testID="vault-filter-apply" label={t('mobileVault.showItems', t('mobileUI.itemCount', pendingCount))} onPress={() => { onFilterChange(draft); setDraft(undefined); }} />
        <AppButton testID="vault-filter-reset" label={labels.reset} variant="text" size="compact" onPress={() => { setDraft(clearVaultFilters(draft)); setOptionQuery(''); }} />
      </>}>
      {options.tagCounts.size + options.collections.length > SEARCHABLE_TAG_LIMIT && <InputControl testID="vault-filter-search"
        accessibilityLabel={labels.searchOptions} placeholder={labels.searchOptions} value={optionQuery} onChangeText={setOptionQuery}
        autoCapitalize="none" autoCorrect={false} containerStyle={local.filterSearch} />}
      <SectionList sections={sections} keyExtractor={(option, index) => `${option.value}-${index}`} keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={[styles.label, local.filterHeading]}>{section.title}</Text>}
        renderItem={({ item, section, index }) => <>
          {index > 0 && <Rule />}
          <SettingsRow label={item.label} testID={`vault-filter-${section.key}-${item.value}`} value={item.count === undefined ? undefined : String(item.count)}
            selected={item.checked} accessibilityRole="checkbox" accessibilityState={{ checked: item.checked }} onPress={item.toggle} />
        </>}
      />
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
        <Rule leading />
        <SettingsRow label={hasExamples ? dict.mobileUI.clearExamples : dict.mobileUI.loadExamples} icon="items"
          testID="vault-example-action" onPress={() => openMore(() => hasExamples ? onClearExamples(EXAMPLE_IDS) : onLoadExamples(exampleItems()))} />
      </Group>
    </BottomSheet>
  </AppPage>;
}

const local = StyleSheet.create({
  header: { gap: space[3] },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  scopes: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  selectedFilters: { gap: space[2] },
  results: { paddingBottom: space[6] },
  filterHeading: { paddingTop: space[2] },
  filterSearch: { marginBottom: space[2] },
});
