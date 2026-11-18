import React, { useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { illustrations } from '../../../../packages/ui/src/native';
import { AppButton, AppPage, BottomSheet, EmptyState, IconButton } from '../components/mobile-ui';
import ItemRow from '../components/ItemRow';
import { useMobileTheme } from '../theme';
import { space, textStyle } from '../ui/tokens';

export default function TrashScreen({ trash, onSelect, onRestore, onPermanentDelete }: {
  trash: VaultItem[]; onSelect: (id: string) => void; onRestore: (id: string) => void; onPermanentDelete: (id: string) => void;
}) {
  const { colors } = useMobileTheme();
  const { t, dict } = useTranslation();
  const [selected, setSelected] = useState<VaultItem | null>(null);
  const close = () => setSelected(null);

  function confirmDelete(item: VaultItem) {
    close();
    Alert.alert(dict.mobile.deleteForeverTitle, dict.mobile.deleteForeverBody, [
      { text: dict.common.cancel, style: 'cancel' },
      { text: dict.common.delete, style: 'destructive', onPress: () => onPermanentDelete(item.id) },
    ]);
  }

  return (
    <AppPage width="list" scroll={false} testID="trash-screen">
      <FlatList
        data={trash}
        keyExtractor={item => item.id}
        ListHeaderComponent={trash.length ? <Text style={[textStyle.helper, { color: colors.muted, marginBottom: space[4] }]}>{t('mobileUI.trashHint')}</Text> : null}
        ListEmptyComponent={<EmptyState image={illustrations.emptyTrash} title={t('mobileUI.trashEmpty')} detail={t('mobileUI.trashEmptyBody')} />}
        renderItem={({ item }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card }}>
            <View style={{ flex: 1 }}><ItemRow item={item} onPress={() => onSelect(item.id)} /></View>
            <IconButton testID={`trash-actions-${item.id}`} accessibilityLabel={`${dict.mobile.actions} · ${item.title}`} icon="more" onPress={() => setSelected(item)} />
          </View>
        )}
      />
      <BottomSheet visible={selected !== null} title={selected?.title ?? ''} onClose={close} testID="trash-actions">
        {selected && (
          <View style={{ gap: space[3] }}>
            <AppButton testID="trash-restore" label={t('mobileUI.restore')} icon="restore" variant="secondary" onPress={() => { close(); onRestore(selected.id); }} />
            <AppButton testID="trash-delete" label={t('mobileUI.deleteForever')} icon="trash" variant="destructive" onPress={() => confirmDelete(selected)} />
          </View>
        )}
      </BottomSheet>
    </AppPage>
  );
}
