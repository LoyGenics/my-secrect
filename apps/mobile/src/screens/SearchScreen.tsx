import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon, illustrations } from '../../../../packages/ui/src/native';
import ItemRow from '../components/ItemRow';
import { AppButton, AppPage, EmptyState, IconButton } from '../components/mobile-ui';
import { InputControl } from '../components/Field';
import { useMobileTheme } from '../theme';
import { space } from '../ui/tokens';
import { activeFilterCount, type VaultFilter } from '../utils/vaultFilter';
import { indexVaultSearch, searchVaultIndex } from '../utils/vaultSearch';

export default function SearchScreen({ items, onSelect, onToggleFavorite, filter, onClearFilters, archived = false }: {
  items: VaultItem[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  filter?: VaultFilter;
  onClearFilters?: () => void;
  archived?: boolean;
}) {
  const { colors, styles } = useMobileTheme();
  const { t, tp, dict, locale } = useTranslation();
  const [query, setQuery] = useState('');
  const index = useMemo(() => indexVaultSearch(items, archived), [items, archived]);
  const results = useMemo(() => searchVaultIndex(index, items, query, filter, locale), [index, items, query, filter, locale]);
  const hasQuery = !!query.trim();
  const count = filter ? activeFilterCount(filter) : 0;
  const header = <View style={local.header}>
    <InputControl
      testID="search-input"
      accessibilityLabel={t('mobileUI.searchAll')}
      placeholder={dict.search.placeholder}
      value={query}
      onChangeText={setQuery}
      autoFocus
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="search"
      leading={<Icon name="search" color={colors.secondaryText} />}
      trailing={!!query && <IconButton testID="search-clear" icon="close" accessibilityLabel={dict.common.clear} onPress={() => setQuery('')} />}
    />
    {count > 0 && <Text style={styles.small}>{t('mobileVault.searchingWithFilters', count)}</Text>}
    <Text testID="search-result-count" accessibilityLiveRegion="polite" style={styles.small}>
      {hasQuery ? tp(dict.mobileVault.itemCount, results.length) : dict.mobileVault.recentlyUpdated}
    </Text>
  </View>;
  return <AppPage width="list" scroll={false} safeArea="bottom" header={header}>
    <FlatList data={results} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={local.results}
      renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => onToggleFavorite(item.id)} />}
      ListEmptyComponent={<EmptyState image={illustrations.noResults}
        title={hasQuery ? t('mobileUI.noResults', query.trim()) : count > 0 ? dict.mobileVault.noMatches : t('mobileUI.searchAll')}
        detail={count > 0 ? dict.mobileVault.noMatchesBody : t('mobileUI.searchHint')}>
        {count > 0 && onClearFilters && <AppButton testID="search-clear-filters" label={dict.mobileVault.clear} variant="secondary" onPress={onClearFilters} />}
      </EmptyState>}
    />
  </AppPage>;
}

const local = StyleSheet.create({
  header: { gap: space[3] },
  results: { paddingBottom: space[6] },
});
