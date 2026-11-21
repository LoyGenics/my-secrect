import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { VaultItem } from '../../../../packages/core/src/types';
import { cardIssuer, cardLast4 } from '../../../../packages/core/src/card';
import { format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import type { Dictionary } from '../../../../packages/i18n/src/en';
import { Icon } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { isArchived } from '../utils/itemMeta';
import { getPrimaryDetailAction, type DetailCopyKey } from '../utils/detailAction';
import { size, space, textStyle } from '../ui/tokens';
import { IconButton } from '../ui/buttons';
import { FilledStar, TypeStamp } from './ledger';

export function typeLabel(dict: Dictionary, type: VaultItem['type']): string {
  return dict.itemTypes[type] ?? type;
}

export function copyLabel(dict: Dictionary, key: DetailCopyKey): string {
  const { itemDetail: d, mobileDetail: detail } = dict;
  const labels: Record<DetailCopyKey, string> = {
    password: d.copyPassword,
    username: d.copyUsername,
    account_number: detail.copyAccountNumber,
    last4: detail.copyCardLast4,
    document_number: detail.copyDocumentNumber,
    key: detail.copyApiKey,
    body: detail.copyNote,
    public_key: detail.copyPublicKey,
    private_key_ref: detail.copyPrivateKeyRef,
  };
  return labels[key];
}

export function itemTitle(item: VaultItem): string {
  return item.type === 'card' ? cardIssuer(item.title, item.fields.bank) : item.title;
}

export function itemSubtitle(dict: Dictionary, item: VaultItem): string {
  const label = typeLabel(dict, item.type);
  const last4 = item.type === 'card' ? cardLast4(item.fields) : '';
  if (last4) return `${label} · •••• ${last4}`;
  if (item.type === 'login' && typeof item.fields.username === 'string' && item.fields.username) return item.fields.username;
  if (item.type === 'bank_account' && typeof item.fields.bank_name === 'string' && item.fields.bank_name !== itemTitle(item)) return item.fields.bank_name;
  return label;
}

/**
 * One ledger line (56 pt): optional A–Z margin letter (40), the type stamp
 * (32), the text column at 84 (60 without letters) and a trailing quick
 * copy for the item's most-used field. `letter` undefined = no margin
 * column; null = an empty margin under a letter already shown.
 */
export default function ItemRow({ item, selected, onPress, letter, quickCopy = true }: {
  item: VaultItem; selected?: boolean; onPress: () => void; letter?: string | null; quickCopy?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const [copied, setCopied] = useState(false);
  const label = typeLabel(dict, item.type);
  const title = itemTitle(item);
  const subtitle = itemSubtitle(dict, item);
  const favorite = item.favorite === true;
  const archived = isArchived(item);
  const action = quickCopy && !item.deleted_at ? getPrimaryDetailAction(item) : undefined;
  const copy = action?.type === 'copy' ? action : undefined;
  const margin = letter !== undefined;
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function quickCopyValue() {
    if (!copy) return;
    try {
      if (!await Clipboard.setStringAsync(copy.value)) throw new Error('Clipboard unavailable');
      setCopied(true);
      AccessibilityInfo.announceForAccessibility(format(dict.mobileVault.copiedNotice, copyLabel(dict, copy.key)));
    } catch {
      AccessibilityInfo.announceForAccessibility(dict.mobileUI.clipboardFailed);
    }
  }

  return (
    <View style={[local.row, selected && { backgroundColor: colors.selection }]}>
      <Pressable testID={`item-row-${item.id}`} accessibilityLabel={`${title}, ${label}${favorite ? `, ${dict.itemDetail.favorite}` : ''}`}
        accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
        style={({ pressed }) => [local.main, !margin && local.flatMain, pressed && { backgroundColor: colors.selection }]}>
        {margin && <Text style={[textStyle.strong, local.letter, { color: colors.plum }]} accessibilityElementsHidden importantForAccessibility="no">
          {letter ?? ''}
        </Text>}
        <TypeStamp type={item.type} />
        <View style={[local.text, { borderBottomColor: colors.border }]}>
          <View style={local.titleLine}>
            <Text numberOfLines={1} style={[textStyle.strong, local.shrink, { color: colors.text }]}>{title}</Text>
            {favorite && <FilledStar color={colors.star} />}
            {archived && <Icon name="archive" size={size.inlineIcon} color={colors.secondaryText} />}
          </View>
          <Text numberOfLines={1} style={[textStyle.caption, { color: colors.secondaryText }]}>{subtitle}</Text>
        </View>
      </Pressable>
      {copy && <View style={[local.trailing, { borderBottomColor: colors.border }]}>
        <IconButton testID={`quick-copy-${item.id}`} icon={copied ? 'check' : 'copy'}
          accessibilityLabel={copied ? dict.common.copied : format(dict.mobileVault.quickCopy, copyLabel(dict, copy.key), title)}
          onPress={() => void quickCopyValue()} />
      </View>}
    </View>
  );
}

const local = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  main: { flex: 1, minWidth: 0, minHeight: size.itemRow, flexDirection: 'row', alignItems: 'center' },
  flatMain: { paddingLeft: space[4] },
  letter: { width: size.marginLetter, paddingLeft: space[4] },
  text: {
    flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', marginLeft: space[3],
    paddingVertical: space[2], borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  shrink: { flexShrink: 1 },
  trailing: { justifyContent: 'center', paddingRight: space[2], borderBottomWidth: StyleSheet.hairlineWidth },
});
