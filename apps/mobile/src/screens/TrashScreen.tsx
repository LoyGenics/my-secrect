import React from 'react';
import { Alert, FlatList, Image, Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import ItemRow from '../components/ItemRow';
import { useMobileTheme } from '../theme';
import { Icon, illustrations, typeArt } from '../../../../packages/ui/src/native';

export default function TrashScreen({ trash, onSelect, onRestore, onPermanentDelete }: {
  trash: VaultItem[]; onSelect: (id: string) => void; onRestore: (id: string) => void; onPermanentDelete: (id: string) => void;
}) {
  const { colors, styles } = useMobileTheme();
  return (
    <View style={styles.screen}>
      <View style={{ padding: 16 }}>
        <Text style={styles.title}>Trash</Text>
        <Text style={styles.subtitle}>Deleted items are kept here as encrypted tombstones until you restore or permanently delete them.</Text>
      </View>
      {trash.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Image source={illustrations.emptyTrash} style={{ width: 120, height: 120 }} accessibilityIgnoresInvertColors />
          <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 12 }}>Trash is empty.</Text>
        </View>
      ) : (
        <FlatList
          data={trash} keyExtractor={(i) => i.id} contentContainerStyle={{ padding: 16, paddingTop: 0 }}
          renderItem={({ item }) => (
            <View>
              <ItemRow item={item} onPress={() => onSelect(item.id)} onToggleFavorite={() => {}} />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: -2, marginBottom: 10 }}>
                <Pressable testID={`trash-restore-${item.id}`} accessibilityLabel={`Restore ${item.title}`} style={[styles.ghostButton, { flex: 1 }]} onPress={() => onRestore(item.id)}><Text style={styles.ghostButtonText}>Restore</Text></Pressable>
                <Pressable testID={`trash-delete-${item.id}`} accessibilityLabel={`Delete ${item.title} permanently`} style={[styles.ghostButton, { flex: 1 }]} onPress={() => Alert.alert('Delete permanently?', 'This cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => onPermanentDelete(item.id) }])}><View style={[styles.led, { backgroundColor: colors.danger }]} /><Text style={[styles.ghostButtonText, { color: colors.dangerText }]}>Delete forever</Text></Pressable>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}
