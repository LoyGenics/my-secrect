import React, { useMemo, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import ItemRow from '../components/ItemRow';
import { colors, styles } from '../theme';
import { searchLocal } from '../vault';
import { isArchived } from '../utils/itemMeta';

export default function SearchScreen({ items, onSelect, onToggleFavorite }: { items: VaultItem[]; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void }) {
  const [q, setQ] = useState('');
  // Local search only, and archived items are excluded (find them under Archived).
  const results = useMemo(() => searchLocal(q).filter((i) => !isArchived(i)), [q]);
  return (
    <View style={styles.screen}>
      <View style={{ padding: 16 }}>
        <Text style={styles.title}>Search</Text>
        <Text style={styles.subtitle}>Instant local search — the query never leaves this device.</Text>
        <TextInput
          testID="search-input" accessibilityLabel="Search items" placeholder="Search title, tags, fields…" placeholderTextColor={colors.faint}
          value={q} onChangeText={setQ} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
          style={[styles.input, { marginTop: 14 }]}
        />
      </View>
      {q.trim() === '' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ fontSize: 40 }}>🔍</Text>
          <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 12 }}>Type to search across {items.length} item(s) — titles, tags and fields.</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ color: colors.muted, fontSize: 15 }}>No results for “{q}”.</Text>
        </View>
      ) : (
        <FlatList data={results} keyExtractor={(i) => i.id} contentContainerStyle={{ padding: 16, paddingTop: 0 }} renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => onToggleFavorite(item.id)} />} />
      )}
    </View>
  );
}
