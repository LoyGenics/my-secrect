import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../packages/core/src/types';
import ItemRow, { CATEGORY_META, categoryForType } from '../components/ItemRow';
import { colors, styles } from '../theme';
import { exampleItems, EXAMPLE_IDS } from '../utils/exampleData';

export type VaultFilter = 'all' | 'favorites' | 'trash' | string; // 'tag:xxx' or a category key

export default function VaultScreen({ items, trash, onSelect, onToggleFavorite, onNew, onLoadExamples, onClearExamples }: {
  items: VaultItem[]; trash: VaultItem[]; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void; onNew: () => void;
  onLoadExamples: (items: VaultItem[]) => void; onClearExamples: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState<VaultFilter>('all');
  const tags = useMemo(() => [...new Set(items.flatMap((i) => i.tags ?? []))].sort(), [items]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, favorites: items.filter((i) => i.favorite).length, trash: trash.length };
    for (const key of Object.keys(CATEGORY_META)) c[key] = items.filter((i) => categoryForType(i.type) === key).length;
    return c;
  }, [items, trash]);
  const visible = useMemo(() => {
    if (filter === 'trash') return trash;
    if (filter === 'favorites') return items.filter((i) => i.favorite);
    if (filter.startsWith('tag:')) return items.filter((i) => (i.tags ?? []).includes(filter.slice(4)));
    if (filter !== 'all') return items.filter((i) => categoryForType(i.type) === filter);
    return items;
  }, [filter, items, trash]);
  const hasExamples = items.some((i) => EXAMPLE_IDS.includes(i.id));
  const chip = (key: string, label: string) => (
    <Pressable key={key} testID={`filter-${key}`} accessibilityLabel={`Filter ${label}`} accessibilityRole="button" onPress={() => setFilter(key)} style={{ backgroundColor: filter === key ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 }}>
      <Text style={{ color: filter === key ? '#FFFFFF' : colors.text, fontSize: 13, fontWeight: '600' }}>{label} ({counts[key] ?? 0})</Text>
    </Pressable>
  );
  return (
    <View style={styles.screen}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.title}>Vault</Text>
          <Pressable testID="new-item-button" accessibilityLabel="Add new item" accessibilityRole="button" onPress={onNew} style={{ backgroundColor: colors.accent, borderRadius: 999, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
            <Text style={{ color: '#FFF', fontSize: 16, fontWeight: '700' }}>+ New</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 0, marginTop: 4 }}>
          {chip('all', 'All Items')}{chip('favorites', '★ Favorites')}{chip('trash', 'Trash')}
          {Object.entries(CATEGORY_META).map(([key, m]) => chip(key, `${m.icon} ${m.label}`))}
        </View>
        {tags.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
            {tags.map((t) => (
              <Pressable key={t} testID={`tag-${t}`} accessibilityLabel={`Filter tag ${t}`} onPress={() => setFilter(`tag:${t}`)} style={{ backgroundColor: filter === `tag:${t}` ? colors.accentSoft : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6, marginBottom: 6 }}>
                <Text style={{ color: '#C7D2FE', fontSize: 12, fontWeight: '600' }}>#{t}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      {visible.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ fontSize: 44 }}>🔒</Text>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 12, textAlign: 'center' }}>{filter === 'trash' ? 'Trash is empty' : 'No items yet'}</Text>
          <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6 }}>{filter === 'trash' ? 'Deleted items are kept here until you permanently delete them.' : 'Tap + New to add your first login, bank account, note or key.'}</Text>
          {!hasExamples && filter === 'all' ? (
            <Pressable testID="load-example-data" accessibilityLabel="Load example data" accessibilityRole="button" style={[styles.ghostButton, { marginTop: 18 }]} onPress={() => onLoadExamples(exampleItems())}>
              <Text style={styles.ghostButtonText}>Load example data</Text>
            </Pressable>
          ) : null}
          {hasExamples ? (
            <Pressable testID="clear-example-data" accessibilityLabel="Clear example data" accessibilityRole="button" style={[styles.ghostButton, { marginTop: 18 }]} onPress={() => onClearExamples(EXAMPLE_IDS)}>
              <Text style={styles.ghostButtonText}>Clear example data</Text>
            </Pressable>
          ) : null}
          <Text style={{ color: colors.faint, fontSize: 12, marginTop: 12 }}>Example data is clearly labelled and uses fake values only.</Text>
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
