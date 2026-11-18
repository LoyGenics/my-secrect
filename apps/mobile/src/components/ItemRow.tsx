import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { cardIssuer, cardLast4 } from '../../../../packages/core/src/card';
import { isFileEntry } from '../../../../packages/core/src/files';
import { Icon } from '../../../../packages/ui/src/native';
import { moduleIcon } from '../../../../packages/ui/src/modules';
import { useTranslation } from '../../../../packages/i18n/src/react';
import type { Dictionary } from '../../../../packages/i18n/src/en';
import { useMobileTheme } from '../theme';
import { isArchived } from '../utils/itemMeta';
import { radius, size, space, textStyle } from '../ui/tokens';
import { IconButton } from '../ui/buttons';

export function typeLabel(dict: Dictionary, type: VaultItem['type']): string {
  return dict.itemTypes[type] ?? type;
}

export default function ItemRow({ item, selected, onPress, onToggleFavorite }: {
  item: VaultItem; selected?: boolean; onPress: () => void; onToggleFavorite?: () => void;
}) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const label = typeLabel(dict, item.type);
  const title = item.type === 'card' ? cardIssuer(item.title, item.fields.bank) : item.title;
  const last4 = item.type === 'card' ? cardLast4(item.fields) : '';
  const favorite = item.favorite === true;
  const archived = isArchived(item);
  let subtitle = label;
  if (last4) subtitle = `${label} · •••• ${last4}`;
  else if (item.type === 'login' && typeof item.fields.username === 'string' && item.fields.username) subtitle = item.fields.username;
  else if (item.type === 'bank_account' && typeof item.fields.bank_name === 'string' && item.fields.bank_name !== title) subtitle = item.fields.bank_name;

  return (
    <View style={{ backgroundColor: selected ? colors.selection : colors.surface }}>
      <View style={local.row}>
        <Pressable testID={`item-row-${item.id}`} accessibilityLabel={`${title}, ${label}`} accessibilityRole="button"
          accessibilityState={{ selected }} onPress={onPress}
          style={({ pressed }) => [local.main, isFileEntry(item) && local.fileRow, pressed && { backgroundColor: colors.selection }]}>
          <View style={[local.glyph, { backgroundColor: colors.surfaceMuted }]}>
            <Icon name={moduleIcon[item.type] ?? 'custom'} color={colors.secondaryText} />
          </View>
          <View style={local.text}>
            <Text style={[textStyle.item, { color: colors.text }]}>{title}</Text>
            <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{subtitle}</Text>
          </View>
          {archived && <Icon name="archive" size={size.inlineIcon} color={colors.secondaryText} />}
        </Pressable>
        {onToggleFavorite && <IconButton testID={`favorite-${item.id}`} icon="favorite" tone={favorite ? 'link' : 'default'}
          accessibilityLabel={favorite ? dict.itemList.removeFavorite : dict.itemList.addFavorite} accessibilityState={{ selected: favorite }}
          style={favorite ? { backgroundColor: colors.selection } : undefined} onPress={onToggleFavorite} />}
      </View>
      <View style={[local.separator, { backgroundColor: colors.border }]} />
    </View>
  );
}

const local = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: space[2] },
  main: { flex: 1, minWidth: 0, minHeight: size.itemRow, flexDirection: 'row', alignItems: 'center', padding: space[3], gap: space[3], borderRadius: radius.glyph },
  fileRow: { minHeight: size.fileRow },
  glyph: { width: space[10], height: space[10], borderRadius: radius.glyph, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space[3] + space[10] + space[3] },
});
