import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useMobileTheme } from '../theme';
import { Icon, type IconName } from '../../../../packages/ui/src/native';
import { Archive, Star } from 'lucide-react-native';
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

const itemIcons: Record<VaultItem['type'], IconName> = {
  login: 'credentials', passkey: 'passkey', bank_account: 'finance', card: 'card',
  identity: 'identity', ssh_key: 'developer', api_key: 'apiKey', secure_note: 'notes',
  document: 'documents', media: 'media', collection: 'collections', custom: 'custom',
};

export default function ItemRow({ item, selected, onPress, onToggleFavorite }: { item: VaultItem; selected?: boolean; onPress: () => void; onToggleFavorite?: () => void }) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const label = typeLabel(dict, item.type);
  const subtitle = typeof item.fields?.username === 'string' ? (item.fields.username as string) : typeof item.fields?.bank_name === 'string' ? (item.fields.bank_name as string) : label;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: selected ? colors.accentSoft : colors.card, borderBottomWidth: 0.5, borderBottomColor: colors.line }}>
    <Pressable
      testID={`item-row-${item.id}`}
      accessibilityLabel={`${item.title}, ${label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 14, minHeight: 72 }}
    >
      <View style={{ marginRight: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2 }}><Icon name={itemIcons[item.type] || 'custom'} size="lg" color={colors.secondary} /></View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{item.title}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{subtitle}</Text>
      </View>
      {isArchived(item) && <Archive size={16} color={colors.muted} />}
    </Pressable>
      {onToggleFavorite && <Pressable testID={`favorite-${item.id}`} accessibilityLabel={item.favorite ? dict.itemList.removeFavorite : dict.itemList.addFavorite} accessibilityRole="button" accessibilityState={{ selected: !!item.favorite }} onPress={onToggleFavorite} style={{ width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: 3 }}>
        <Star size={20} color={item.favorite ? colors.link : colors.muted} fill={item.favorite ? colors.link : 'transparent'} />
      </Pressable>}
    </View>
  );
}
