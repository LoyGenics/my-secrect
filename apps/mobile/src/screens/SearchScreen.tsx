import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon, illustrations } from '../../../../packages/ui/src/native';
import ItemRow from '../components/ItemRow';
import { AppButton, EmptyState, IconButton } from '../components/mobile-ui';
import { InputControl } from '../components/Field';
import { Cover } from '../components/ledger';
import { useMobileTheme } from '../theme';
import { space, textStyle } from '../ui/tokens';
import { activeFilterCount, type VaultFilter } from '../utils/vaultFilter';
import { indexVaultSearch, searchVaultIndex } from '../utils/vaultSearch';

export default function SearchScreen({ items, onSelect, filter, onClearFilters, archived = false, title, onNew }: {
  items: VaultItem[];
  onSelect: (id: string) => void;
  filter?: VaultFilter;
  onClearFilters?: () => void;
  archived?: boolean;
  /** A dock root shows its own cover; the modal search uses the stack header. */
  title?: string;
  onNew?: () => void;
}) {
  const { colors, styles } = useMobileTheme();
  const { t, tp, dict, locale } = useTranslation();
  const [query, setQuery] = useState('');
  const index = useMemo(() => indexVaultSearch(items, archived), [items, archived]);
  const results = useMemo(() => searchVaultIndex(index, items, query, filter, locale), [index, items, query, filter, locale]);
  const hasQuery = !!query.trim();
  const count = filter ? activeFilterCount(filter) : 0;
  const input = useRef<TextInput>(null);
  // The Search button lands on a focused field, every time it is opened.
  useFocusEffect(useCallback(() => {
    const timer = setTimeout(() => input.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, []));
  const field = <InputControl
      ref={input}
      boxed
      containerStyle={local.field}
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
    />;
  const header = <View style={local.header}>
    {!title && field}
    {count > 0 && <Text style={styles.small}>{t('mobileVault.searchingWithFilters', count)}</Text>}
    <Text testID="search-result-count" accessibilityLiveRegion="polite" style={[textStyle.strong, { color: hasQuery ? colors.secondaryText : colors.text }]}>
      {hasQuery ? tp(dict.mobileVault.itemCount, results.length) : dict.mobileVault.recentlyUpdated}
    </Text>
  </View>;
  return <View style={[local.flex, { backgroundColor: colors.canvas }]}>
    {title && <Cover title={title}>{field}</Cover>}
    <FlatList data={results} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      style={local.flex} contentContainerStyle={local.results} ListHeaderComponent={header}
      renderItem={({ item }) => <ItemRow item={item} onPress={() => onSelect(item.id)} />}
      ListEmptyComponent={<EmptyState image={illustrations.noResults}
        title={hasQuery ? t('mobileUI.noResults', query.trim()) : count > 0 ? dict.mobileVault.noMatches : t('mobileUI.searchAll')}
        detail={count > 0 ? dict.mobileVault.noMatchesBody : t('mobileUI.searchHint')}>
        {count > 0 && onClearFilters && <AppButton testID="search-clear-filters" label={dict.mobileVault.clear} variant="secondary" onPress={onClearFilters} />}
        {hasQuery && <View style={local.emptyActions}>
          <AppButton testID="search-clear-query" label={dict.mobileVault.clearSearch} variant="secondary" onPress={() => setQuery('')} />
          {onNew && <AppButton testID="search-new-item" label={t('mobileUI.newItem')} icon="add" variant="text" onPress={onNew} />}
        </View>}
      </EmptyState>}
    />
  </View>;
}

const local = StyleSheet.create({
  flex: { flex: 1 },
  field: { marginTop: space[1] },
  header: { gap: space[3], paddingHorizontal: space[4], paddingTop: space[4], paddingBottom: space[2] },
  results: { paddingBottom: space[6] },
  emptyActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[3] },
});
