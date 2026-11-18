import React, { useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Search, X } from 'lucide-react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { illustrations } from '../../../../packages/ui/src/native';
import ItemRow from '../components/ItemRow';
import { Empty, IconButton } from '../components/mobile-ui';
import { InputControl } from '../components/Field';
import { useMobileTheme } from '../theme';
import { searchLocal } from '../vault';

export default function SearchScreen({ items, onSelect, onToggleFavorite }: { items: VaultItem[]; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void }) {
  const { colors } = useMobileTheme(); const { t, dict } = useTranslation();
  const [q, setQ] = useState('');
  // The live item index is also a dependency: edits and imports refresh results.
  // Archived items remain searchable; deleted items live in Trash.
  const results = useMemo(() => q.trim() ? searchLocal(q) : [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8), [q, items]);
  return <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <FlatList data={results} keyExtractor={i => i.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 20, paddingTop: 8, paddingBottom: 40, width: '100%', maxWidth: 820, alignSelf: 'center' }}
      ListHeaderComponent={<View style={{ marginBottom: 18 }}>
        <InputControl
          testID="search-input"
          accessibilityLabel={t('mobileUI.searchAll')}
          placeholder={dict.search.placeholder}
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          leading={<Search size={19} color={colors.muted} />}
          trailing={!!q && <IconButton accessibilityLabel={dict.common.clear} onPress={() => setQ('')}><X size={18} color={colors.muted} /></IconButton>}
        />
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 12 }}>{q.trim() ? t('mobileUI.itemCount', results.length) : t('mobileUI.recentItems')}</Text>
      </View>}
      renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => onToggleFavorite(item.id)} />}
      ListEmptyComponent={<Empty image={illustrations.noResults} title={q.trim() ? t('mobileUI.noResults', q) : t('mobileUI.searchAll')} detail={t('mobileUI.searchHint')} />}
    />
  </View>;
}
