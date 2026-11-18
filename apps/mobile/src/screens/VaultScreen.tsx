import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { ArrowDownUp, MoreHorizontal } from 'lucide-react-native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import type { VaultItem } from '../../../../packages/core/src/types';
import ItemRow, { CATEGORY_META, categoryForType } from '../components/ItemRow';
import { useMobileTheme } from '../theme';
import { illustrations } from '../../../../packages/ui/src/native';
import { exampleItems, EXAMPLE_IDS } from '../utils/exampleData';
import { isFileEntry } from '../../../../packages/core/src/files';
import { isArchived } from '../utils/itemMeta';
import { Empty, SearchTrigger, Select } from '../components/mobile-ui';

export type VaultFilter = 'all' | 'favorites' | 'trash' | 'archived' | string;
export type VaultSort = 'updated' | 'title' | 'created';
export default function VaultScreen({ items, trash, onSelect, onToggleFavorite, onNew, onLoadExamples, onClearExamples, onSearch, onOpen }: {
  items: VaultItem[]; trash: VaultItem[]; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void; onNew: () => void;
  onLoadExamples: (items: VaultItem[]) => void; onClearExamples: (ids: string[]) => void;
  onSearch?: () => void; onOpen?: (screen: 'Shares' | 'Family') => void;
}) {
  const { colors } = useMobileTheme();const { dict, t } = useTranslation();
  const [filter, setFilter] = useState<VaultFilter>('all');const [sort, setSort] = useState<VaultSort>('updated');
  const live = useMemo(() => items.filter(i => !isArchived(i) && !isFileEntry(i)), [items]);
  const archived = useMemo(() => items.filter(i => isArchived(i) && !isFileEntry(i)), [items]);
  const tags = useMemo(() => [...new Set(live.flatMap(i => i.tags ?? []))].sort(), [live]);
  const hasExamples = items.some(i => EXAMPLE_IDS.includes(i.id));
  const countFor = (value: string) => value === 'all' ? live.length : value === 'favorites' ? live.filter(i => i.favorite).length : value === 'trash' ? trash.length : value === 'archived' ? archived.length : value.startsWith('tag:') ? live.filter(i => i.tags?.includes(value.slice(4))).length : live.filter(i => categoryForType(i.type) === value).length;
  const choices = [
    { value: 'all', label: dict.shell.allItems }, { value: 'favorites', label: dict.shell.favorites },
    ...Object.keys(CATEGORY_META).filter(value => !['media','documents'].includes(value)).map(value => ({ value, label: (dict.categories as Record<string, string>)[value] })),
    ...tags.map(tag => ({ value: `tag:${tag}`, label: `#${tag}` })),
    { value: 'archived', label: dict.shell.archived }, { value: 'trash', label: dict.shell.trash },
  ].map(choice => ({ ...choice, detail: t('mobileUI.itemCount', countFor(choice.value)) }));
  const visible = useMemo(() => {
    const source = filter === 'trash' ? trash : filter === 'archived' ? archived : filter === 'favorites' ? live.filter(i => i.favorite) : filter.startsWith('tag:') ? live.filter(i => i.tags?.includes(filter.slice(4))) : filter === 'all' ? live : live.filter(i => categoryForType(i.type) === filter);
    return [...source].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : (sort === 'created' ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at)));
  }, [filter, sort, live, archived, trash]);
  function menu() {
    Alert.alert(t('mobileUI.vaultActions'), undefined, [
      { text: dict.shell.sharing, onPress: () => onOpen?.('Shares') },
      { text: dict.family.title, onPress: () => onOpen?.('Family') },
      { text: hasExamples ? dict.mobileUI.clearExamples : dict.mobileUI.loadExamples, onPress: () => hasExamples ? onClearExamples(EXAMPLE_IDS) : onLoadExamples(exampleItems()) },
      ...(Platform.OS === 'ios' ? [{ text: dict.common.cancel, style: 'cancel' as const }] : []),
    ], { cancelable: true });
  }
  return <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <FlatList data={visible} keyExtractor={i => i.id} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingBottom: 32 }}
      ListHeaderComponent={<View style={{ paddingTop: 8, paddingBottom: 12 }}>
        <SearchTrigger onPress={() => onSearch?.()} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <Select value={filter} choices={choices} onChange={setFilter} label={t('mobileUI.categories')} testID="vault-filter" />
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable testID="vault-sort" accessibilityRole="button" accessibilityLabel={t('mobileUI.sort')} onPress={() => Alert.alert(t('mobileUI.sort'), undefined, [
              ...(['updated', 'title', 'created'] as const).map(value => ({ text: value === 'updated' ? dict.shell.sortUpdated : value === 'title' ? dict.shell.sortTitle : dict.shell.sortCreated, onPress: () => setSort(value) })), ...(Platform.OS === 'ios' ? [{ text: dict.common.cancel, style: 'cancel' as const }] : []),
            ], { cancelable: true })} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><ArrowDownUp size={19} color={colors.muted} /></Pressable>
            <Pressable testID="vault-more" accessibilityRole="button" accessibilityLabel={t('mobileUI.vaultActions')} onPress={menu} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><MoreHorizontal size={22} color={colors.muted} /></Pressable>
          </View>
        </View>
        <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 4 }}>{t('mobileUI.itemCount', visible.length)}</Text>
      </View>}
      renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => onToggleFavorite(item.id)} />}
      ListEmptyComponent={<Empty image={filter === 'trash' ? illustrations.emptyTrash : illustrations.emptyVault} title={filter === 'all' ? dict.shell.empty.allTitle : t('mobileUI.noItems')} detail={filter === 'all' ? dict.mobile.emptyAllBody : t('mobileUI.changeFilter')}>
        {filter === 'all' && <Pressable testID="empty-new-item" accessibilityRole="button" accessibilityLabel={dict.shell.newItem} onPress={onNew} style={{ minHeight: 48, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: colors.link, fontWeight: '600', fontSize: 16 }}>{dict.shell.newItem}</Text></Pressable>}
      </Empty>}
    />
  </View>;
}
