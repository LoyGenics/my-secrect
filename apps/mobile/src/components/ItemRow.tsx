import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { colors } from '../theme';
import { TypeModule } from '../../../../packages/ui/src/native';
import { lightTheme } from '../../../../packages/ui/src/tokens';
import { useTranslation } from '../../../../packages/i18n/src/react';
import type { Dictionary } from '../../../../packages/i18n/src/en';
import { isArchived } from '../utils/itemMeta';

/** Category keys shown as filter chips on the vault screen (labels come from `dict.categories`). */
export const CATEGORY_META: Record<string, true> = {
  credentials: true,
  finance: true,
  identity: true,
  developer: true,
  notes: true,
  media: true,
  documents: true,
  collections: true,
};
export function categoryForType(type: VaultItem['type']): string {
  if (type === 'login' || type === 'passkey') return 'credentials';
  if (type === 'bank_account' || type === 'card') return 'finance';
  if (type === 'identity') return 'identity';
  if (type === 'ssh_key' || type === 'api_key') return 'developer';
  if (type === 'secure_note') return 'notes';
  if (type === 'media') return 'media';
  if (type === 'document') return 'documents';
  return 'collections';
}
/** Localized item type name (`dict.itemTypes`). */
export function typeLabel(dict: Dictionary, type: VaultItem['type']): string {
  return (dict.itemTypes as Record<string, string>)[type] ?? type;
}

export default function ItemRow({ item, selected, onPress, onToggleFavorite }: { item: VaultItem; selected?: boolean; onPress: () => void; onToggleFavorite: () => void }) {
  const { dict } = useTranslation();
  const label = typeLabel(dict, item.type);
  const subtitle = typeof item.fields?.username === 'string' ? (item.fields.username as string) : typeof item.fields?.bank_name === 'string' ? (item.fields.bank_name as string) : label;
  return (
    <Pressable
      testID={`item-row-${item.id}`}
      accessibilityLabel={`${item.title}, ${label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: selected ? colors.accentSoft : colors.card, borderRadius: 14, padding: 10, marginBottom: 6, minHeight: 64 }}
    >
      <View style={{ marginRight: 12 }}>
        <TypeModule type={item.type} theme={lightTheme} size={44} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{item.title}{isArchived(item) ? '  📦' : ''}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Pressable testID={`favorite-${item.id}`} accessibilityLabel={item.favorite ? dict.itemList.removeFavorite : dict.itemList.addFavorite} accessibilityRole="button" onPress={onToggleFavorite} hitSlop={12}>
        <Text style={{ fontSize: 20, color: item.favorite ? colors.warn : colors.faint }}>{item.favorite ? '★' : '☆'}</Text>
      </Pressable>
    </Pressable>
  );
}
