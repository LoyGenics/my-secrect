import React, { useContext, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { SlidersHorizontal, Star } from 'lucide-react-native';
import type { ItemType } from '../../../../packages/core/src/types';
import { LS_ACCOUNT_EMAIL } from '../../../../packages/sdk/src/security';
import { Icon } from '../../../../packages/ui/src/native';
import { moduleIcon } from '../../../../packages/ui/src/modules';
import { iconStrokeWidth } from '../../../../packages/ui/src/icons';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { radius, size, space, textStyle, type StampFamily } from '../ui/tokens';

/** Which calm stamp family each item type wears. */
export const typeStampFamily: Record<ItemType, StampFamily> = {
  login: 'access', passkey: 'access',
  card: 'money', bank_account: 'money',
  identity: 'identity',
  secure_note: 'note', custom: 'note',
  document: 'file', media: 'file',
  ssh_key: 'dev', api_key: 'dev',
  collection: 'group',
};

/** 32 pt tinted stamp with the type glyph; cards wear a mini card in their family tint. */
export function TypeStamp({ type, large }: { type: ItemType; large?: boolean }) {
  const { colors } = useMobileTheme();
  const stamp = colors.stamp[typeStampFamily[type]];
  const box = large ? size.stamp + space[4] : size.stamp;
  if (type === 'card') {
    return <View accessible={false} style={[local.stampSlot, { width: box, height: box }]}>
      <View style={[local.miniCard, { backgroundColor: stamp.ink, width: box, height: Math.round(box * 0.625) }]}>
        <View style={[local.miniChip, { backgroundColor: stamp.bg }]} />
      </View>
    </View>;
  }
  return <View accessible={false} style={[local.stampSlot, { width: box, height: box, borderRadius: box / 2, backgroundColor: stamp.bg }]}>
    <Icon name={moduleIcon[type]} size={large ? 'xl' : 'lg'} color={stamp.ink} />
  </View>;
}

export function FilledStar({ size: px = size.inlineIcon, color }: { size?: number; color: string }) {
  return <Star size={px} color={color} fill={color} strokeWidth={iconStrokeWidth} accessible={false} />;
}

export function FilterGlyph({ color }: { color: string }) {
  return <SlidersHorizontal size={size.tabIcon} color={color} strokeWidth={iconStrokeWidth} accessible={false} />;
}

/** The signed-in account email (stored at sign-in), for the avatar and account sheet. */
export function useAccountEmail(): string {
  const [email, setEmail] = useState('');
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(LS_ACCOUNT_EMAIL).then((value) => { if (active) setEmail(value ?? ''); }, () => undefined);
    return () => { active = false; };
  }, []);
  return email;
}

export function initials(email: string): string {
  const name = email.split('@')[0] ?? '';
  const parts = name.split(/[._\-+]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || name.slice(0, 2).toUpperCase();
}

export function Avatar({ email, onPress, large }: { email: string; onPress?: () => void; large?: boolean }) {
  const { colors } = useMobileTheme();
  const { dict, t } = useTranslation();
  const letters = initials(email);
  const box = large ? space[12] : size.avatar;
  const face = <View style={[local.avatar, { width: box, height: box, borderRadius: box / 2, backgroundColor: colors.coverChipSelected }]}>
    {letters ? <Text style={[large ? textStyle.strong : textStyle.label, { color: colors.onCoverChipSelected }]}>{letters}</Text>
      : <Icon name="person" color={colors.onCoverChipSelected} />}
  </View>;
  if (!onPress) return face;
  return <Pressable testID="cover-avatar" accessibilityRole="button" onPress={onPress}
    accessibilityLabel={email ? t('mobileVault.accountFor', email) : dict.mobileVault.account}
    style={local.avatarTarget}>{face}</Pressable>;
}

/**
 * The cover band at the top of every root: pale plum in Light, full plum in
 * Dark. A bar (leading avatar / back, trailing action), the Display title,
 * then scope chips or fields as children.
 */
export function Cover({ title, leading, trailing, children, eyebrow, style, titleTestID }: {
  title?: string; leading?: ReactNode; trailing?: ReactNode; children?: ReactNode; eyebrow?: string;
  style?: StyleProp<ViewStyle>; titleTestID?: string;
}) {
  const { colors } = useMobileTheme();
  const insets = useContext(SafeAreaInsetsContext);
  return <View style={[local.cover, { backgroundColor: colors.cover, borderBottomColor: colors.coverLine, paddingTop: (insets?.top ?? 0) + space[2],
    paddingLeft: space[4] + (insets?.left ?? 0), paddingRight: space[4] + (insets?.right ?? 0) }, style]}>
    {(leading || trailing || eyebrow) && <View style={local.coverBar}>
      <View style={local.coverSide}>{leading}</View>
      {eyebrow && <Text style={[textStyle.strong, local.eyebrow, { color: colors.onCover }]} numberOfLines={1}>{eyebrow}</Text>}
      <View style={[local.coverSide, local.coverTrailing]}>{trailing}</View>
    </View>}
    {title && <Text testID={titleTestID} accessibilityRole="header" style={[textStyle.display, { color: colors.onCover }]} numberOfLines={2}>{title}</Text>}
    {children}
  </View>;
}

/** A 44 pt icon button on the cover (back, close, add). */
export function CoverIconButton({ icon, label, onPress, testID }: {
  icon: 'add' | 'back' | 'close' | 'more'; label: string; onPress: () => void; testID?: string;
}) {
  const { colors } = useMobileTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={space[1]}
    style={({ pressed }) => [local.coverIcon, pressed && { backgroundColor: colors.coverChip }]}>
    <Icon name={icon} size="xl" color={colors.onCover} />
  </Pressable>;
}

/** "37 items" on the left and the sort control (plum) on the right. */
export function SortLine({ count, sortLabel, onSort, testID = 'vault-sort' }: {
  count: string; sortLabel?: string; onSort?: () => void; testID?: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useTranslation();
  return <View style={local.sortLine}>
    <Text testID="vault-result-count" accessibilityLiveRegion="polite" style={[textStyle.caption, local.flex, { color: colors.secondaryText }]}>{count}</Text>
    {sortLabel && onSort && <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={t('mobileVault.sortBy', sortLabel)} onPress={onSort}
      style={({ pressed }) => [local.sortButton, pressed && { backgroundColor: colors.selection }]}>
      <Icon name="sort" size="md" color={colors.plum} />
      <Text style={[textStyle.control, { color: colors.plum }]}>{sortLabel}</Text>
    </Pressable>}
  </View>;
}

/** Margin letter for a title (A–Z, digits and symbols under #). */
export function ledgerLetter(title: string, locale: string): string {
  const first = title.trim().charAt(0).normalize('NFD').charAt(0).toLocaleUpperCase(locale);
  return /\p{L}/u.test(first) ? first : '#';
}

const local = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  stampSlot: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  miniCard: { borderRadius: radius.checkbox, padding: space[1] },
  miniChip: { width: space[2] + 2, height: space[2] - 2, borderRadius: 2, opacity: 0.8 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarTarget: { minWidth: size.touch, minHeight: size.touch, justifyContent: 'center' },
  cover: { paddingBottom: space[4], gap: space[3], borderBottomWidth: StyleSheet.hairlineWidth },
  coverBar: { flexDirection: 'row', alignItems: 'center', minHeight: size.touch },
  coverSide: { minWidth: size.touch, flexDirection: 'row', alignItems: 'center' },
  coverTrailing: { marginLeft: 'auto', justifyContent: 'flex-end' },
  eyebrow: { flex: 1, textAlign: 'center' },
  coverIcon: { width: size.touch, height: size.touch, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
  sortLine: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[1], minHeight: size.touch + space[4] },
  sortButton: { flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: size.touch, paddingHorizontal: space[2], marginRight: -space[2], borderRadius: radius.chip },
});
