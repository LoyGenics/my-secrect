import React from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { MoreHorizontal } from 'lucide-react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { illustrations } from '../../../../packages/ui/src/native';
import { Empty } from '../components/mobile-ui';
import ItemRow from '../components/ItemRow';
import { useMobileTheme } from '../theme';

export default function TrashScreen({ trash, onSelect, onRestore, onPermanentDelete }: {
  trash: VaultItem[]; onSelect: (id: string) => void; onRestore: (id: string) => void; onPermanentDelete: (id: string) => void;
}) {
  const { colors } = useMobileTheme(); const { t, dict } = useTranslation();
  function menu(item: VaultItem) {
    Alert.alert(item.title, undefined, [
      { text: t('mobileUI.restore'), onPress: () => onRestore(item.id) },
      { text: t('mobileUI.deleteForever'), style: 'destructive', onPress: () => Alert.alert(dict.mobile.deleteForeverTitle, dict.mobile.deleteForeverBody, [{ text: dict.common.cancel, style: 'cancel' }, { text: dict.common.delete, style: 'destructive', onPress: () => onPermanentDelete(item.id) }]) },
      { text: dict.common.cancel, style: 'cancel' },
    ]);
  }
  return <FlatList style={{ backgroundColor: colors.bg }} contentInsetAdjustmentBehavior="automatic" data={trash} keyExtractor={i => i.id} contentContainerStyle={{ padding: 20, paddingBottom: 40, width: '100%', maxWidth: 820, alignSelf: 'center' }}
    ListHeaderComponent={!!trash.length ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 20 }}>{t('mobileUI.trashHint')}</Text> : null}
    ListEmptyComponent={<Empty image={illustrations.emptyTrash} title={t('mobileUI.trashEmpty')} detail={t('mobileUI.trashEmptyBody')} />}
    renderItem={({ item }) => <View style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ flex: 1 }}><ItemRow item={item} onPress={() => onSelect(item.id)} /></View><Pressable testID={`trash-actions-${item.id}`} accessibilityRole="button" accessibilityLabel={`${dict.mobile.actions}: ${item.title}`} onPress={() => menu(item)} style={{ width: 44, height: 54, alignItems: 'center', justifyContent: 'center' }}><MoreHorizontal size={22} color={colors.muted} /></Pressable></View>}
  />;
}
