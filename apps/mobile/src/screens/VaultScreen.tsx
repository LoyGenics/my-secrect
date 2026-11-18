import React, { useMemo, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';
import type { VaultItem } from '../../../../packages/core/src/types';
import ItemRow, { CATEGORY_META, categoryForType } from '../components/ItemRow';
import { useMobileTheme } from '../theme';
import { Icon, illustrations } from '../../../../packages/ui/src/native';
import { exampleItems, EXAMPLE_IDS } from '../utils/exampleData';
import { isArchived } from '../utils/itemMeta';
import MediaScreen from './MediaScreen';
import SharesScreen from './SharesScreen';
import FamilyScreen from './FamilyScreen';

export type VaultFilter = 'all' | 'favorites' | 'trash' | 'archived' | string; // 'tag:xxx' or a category key
export type VaultSort = 'updated' | 'title' | 'created';

export default function VaultScreen({ items, trash, onSelect, onToggleFavorite, onNew, onLoadExamples, onClearExamples }: {
  items: VaultItem[]; trash: VaultItem[]; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void; onNew: () => void;
  onLoadExamples: (items: VaultItem[]) => void; onClearExamples: (ids: string[]) => void;
}) {
  const { colors, styles } = useMobileTheme();
  const { dict } = useTranslation();
  const m = dict.mobile;
  const SORT_LABELS: Record<VaultSort, string> = { updated: dict.shell.sortUpdated, title: dict.shell.sortTitle, created: dict.shell.sortCreated };
  const [filter, setFilter] = useState<VaultFilter>('all');
  const [sort, setSort] = useState<VaultSort>('updated');
  const [overlay, setOverlay] = useState<'media' | 'shares' | 'family' | null>(null);
  // Archived items are hidden from All / categories / tags until unarchived
  // (archiving itself is done on desktop for now — see README note in report).
  const liveItems = useMemo(() => items.filter((i) => !isArchived(i)), [items]);
  const archivedItems = useMemo(() => items.filter((i) => isArchived(i)), [items]);
  const tags = useMemo(() => [...new Set(liveItems.flatMap((i) => i.tags ?? []))].sort(), [liveItems]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: liveItems.length, favorites: liveItems.filter((i) => i.favorite).length, trash: trash.length, archived: archivedItems.length };
    for (const key of Object.keys(CATEGORY_META)) c[key] = liveItems.filter((i) => categoryForType(i.type) === key).length;
    return c;
  }, [liveItems, archivedItems, trash]);
  const visible = useMemo(() => {
    let base: VaultItem[];
    if (filter === 'trash') base = trash;
    else if (filter === 'archived') base = archivedItems;
    else if (filter === 'favorites') base = liveItems.filter((i) => i.favorite);
    else if (filter.startsWith('tag:')) base = liveItems.filter((i) => (i.tags ?? []).includes(filter.slice(4)));
    else if (filter !== 'all') base = liveItems.filter((i) => categoryForType(i.type) === filter);
    else base = liveItems;
    const sorted = [...base];
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'created') sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    else sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sorted;
  }, [filter, liveItems, archivedItems, trash, sort]);
  const hasExamples = items.some((i) => EXAMPLE_IDS.includes(i.id));
  const chip = (key: string, label: string) => (
    <Pressable key={key} testID={`filter-${key}`} accessibilityLabel={format(m.filterLabel, label)} accessibilityRole="button" onPress={() => setFilter(key)} style={{ backgroundColor: filter === key ? colors.text : colors.card, borderColor: filter === key ? colors.text : colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, marginBottom: 8 }}>
      <Text style={{ color: filter === key ? colors.card : colors.text, fontSize: 13, fontWeight: '600' }}>{label} ({counts[key] ?? 0})</Text>
    </Pressable>
  );
  if (overlay === 'family') return <FamilyScreen onClose={() => setOverlay(null)} />;
  if (overlay === 'media') {
    return <MediaScreen items={items} onClose={() => setOverlay(null)} onSelect={(id) => { setOverlay(null); onSelect(id); }} />;
  }
  if (overlay === 'shares') {
    return <SharesScreen onClose={() => setOverlay(null)} />;
  }
  return (
    <View style={styles.screen}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text accessibilityRole="header" style={styles.title}>{dict.shell.tabs.vault}</Text>
          <Pressable testID="new-item-button" accessibilityLabel={dict.shell.newItem} accessibilityRole="button" onPress={onNew} style={{ backgroundColor: colors.accent, borderRadius: 999, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
            <Text style={styles.primaryButtonText}>{m.newShort}</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 0, marginTop: 4 }}>
          {chip('all', dict.shell.allItems)}{chip('favorites', dict.shell.favorites)}{chip('trash', dict.shell.trash)}{chip('archived', dict.shell.archived)}
          {Object.keys(CATEGORY_META).map((key) => chip(key, (dict.categories as Record<string, string>)[key] ?? key))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
          <Pressable testID="open-media" accessibilityLabel={dict.shell.mediaGallery} style={[styles.ghostButton, { marginRight: 8, marginBottom: 0 }]} onPress={() => setOverlay('media')}>
            <Icon name="gallery" color={colors.text} /><Text style={styles.ghostButtonText}>{dict.shell.mediaGallery}</Text>
          </Pressable>
          <Pressable testID="open-family" accessibilityRole="button" accessibilityLabel={dict.family.title} style={[styles.ghostButton, { marginRight: 8, marginBottom: 0 }]} onPress={() => setOverlay('family')}><Icon name="share" color={colors.text} /><Text style={styles.ghostButtonText}>{dict.family.title}</Text></Pressable>
          <Pressable testID="open-shares" accessibilityLabel={dict.shell.sharing} style={[styles.ghostButton, { marginBottom: 0 }]} onPress={() => setOverlay('shares')}>
            <Icon name="share" color={colors.text} /><Text style={styles.ghostButtonText}>{dict.shell.sharing}</Text>
          </Pressable>
          <Pressable testID="sort-cycle" accessibilityLabel={`${format(m.sortBy, SORT_LABELS[sort])}. ${m.sortHint}`} style={[styles.ghostButton, { marginLeft: 8, marginBottom: 0 }]} onPress={() => setSort((s) => (s === 'updated' ? 'title' : s === 'title' ? 'created' : 'updated'))}>
            <Text style={styles.ghostButtonText}>{format(m.sortBy, SORT_LABELS[sort])}</Text>
          </Pressable>
        </View>
        {tags.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
            {tags.map((t) => (
              <Pressable key={t} testID={`tag-${t}`} accessibilityLabel={format(m.filterTag, t)} onPress={() => setFilter(`tag:${t}`)} style={{ backgroundColor: filter === `tag:${t}` ? colors.accentSoft : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6, marginBottom: 6 }}>
                <Text style={{ color: filter === `tag:${t}` ? colors.text : colors.secondary, fontSize: 12, fontWeight: '600' }}>#{t}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      {visible.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Image source={filter === 'trash' ? illustrations.emptyTrash : filter === 'archived' ? illustrations.emptyArchive : illustrations.emptyVault} style={{ width: 136, height: 136 }} accessibilityIgnoresInvertColors />
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 12, textAlign: 'center' }}>{filter === 'trash' ? dict.shell.empty.trashTitle : filter === 'archived' ? dict.shell.empty.archivedTitle : dict.shell.empty.allTitle}</Text>
          <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6 }}>{filter === 'trash' ? dict.shell.empty.trashBody : filter === 'archived' ? m.emptyArchivedBody : m.emptyAllBody}</Text>
          {!hasExamples && filter === 'all' ? (
            <Pressable testID="load-example-data" accessibilityLabel={dict.shell.loadExample} accessibilityRole="button" style={[styles.ghostButton, { marginTop: 18 }]} onPress={() => onLoadExamples(exampleItems())}>
              <Text style={styles.ghostButtonText}>{dict.shell.loadExample}</Text>
            </Pressable>
          ) : null}
          {hasExamples ? (
            <Pressable testID="clear-example-data" accessibilityLabel={dict.shell.clearExample} accessibilityRole="button" style={[styles.ghostButton, { marginTop: 18 }]} onPress={() => onClearExamples(EXAMPLE_IDS)}>
              <Text style={styles.ghostButtonText}>{dict.shell.clearExample}</Text>
            </Pressable>
          ) : null}
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 12, textAlign: 'center' }}>{dict.shell.exampleNote}</Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => onToggleFavorite(item.id)} />}
        />
      )}
    </View>
  );
}
