import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { colors } from '../theme';
import { isArchived } from '../utils/itemMeta';

export const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  credentials: { label: 'Credentials', icon: '🔑' },
  finance: { label: 'Finance', icon: '🏦' },
  identity: { label: 'Identity', icon: '🪪' },
  developer: { label: 'Developer', icon: '💻' },
  notes: { label: 'Secure Notes', icon: '📝' },
  media: { label: 'Private Media', icon: '🖼️' },
  documents: { label: 'Documents', icon: '📄' },
  collections: { label: 'Collections', icon: '🗂️' },
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
export function typeLabel(type: VaultItem['type']): string {
  return ({ login: 'Login', passkey: 'Passkey', bank_account: 'Bank account', card: 'Card', identity: 'Identity', ssh_key: 'SSH key', api_key: 'API key', secure_note: 'Secure note', document: 'Document', media: 'Media', collection: 'Collection', custom: 'Custom' } as Record<string, string>)[type] ?? type;
}

export default function ItemRow({ item, selected, onPress, onToggleFavorite }: { item: VaultItem; selected?: boolean; onPress: () => void; onToggleFavorite: () => void }) {
  const cat = CATEGORY_META[categoryForType(item.type)];
  const subtitle = typeof item.fields?.username === 'string' ? (item.fields.username as string) : typeof item.fields?.bank_name === 'string' ? (item.fields.bank_name as string) : typeLabel(item.type);
  return (
    <Pressable
      testID={`item-row-${item.id}`}
      accessibilityLabel={`${item.title}, ${typeLabel(item.type)}`}
      accessibilityRole="button"
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: selected ? colors.accentSoft : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 8 }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.input, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
        <Text style={{ fontSize: 22 }}>{cat.icon}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{item.title}{isArchived(item) ? '  📦' : ''}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Pressable testID={`favorite-${item.id}`} accessibilityLabel={item.favorite ? 'Remove from favorites' : 'Add to favorites'} accessibilityRole="button" onPress={onToggleFavorite} hitSlop={12}>
        <Text style={{ fontSize: 20, color: item.favorite ? '#F59E0B' : colors.faint }}>{item.favorite ? '★' : '☆'}</Text>
      </Pressable>
    </Pressable>
  );
}
