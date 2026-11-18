import React, { type ReactNode } from 'react';
import { Image, StyleSheet, Text, View, useWindowDimensions, type TextInputProps, type ViewStyle } from 'react-native';
import { type NativeIconName } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { size, space, textStyle } from '../ui/tokens';
import { AppTextField } from './Field';
import { AppButton, AppPage, FieldGroup, InlineError } from './mobile-ui';

export { useReducedMotion } from '../ui/motion';

/** @deprecated Read semantic colors from useMobileTheme. */
export function useSoftPalette() {
  const { colors } = useMobileTheme();
  return {
    bg: colors.canvas, surface: colors.surface, surface2: colors.surfaceMuted, line: colors.border,
    ink: colors.text, ink2: colors.secondaryText, ink3: colors.mutedText,
    brandFill: colors.primaryFill, brand: colors.primaryTextLink, brandSoft: colors.selection,
    brandText: colors.primaryTextLink, focus: colors.focus, danger: colors.dangerText,
    dangerSoft: colors.dangerSoft, warnSoft: colors.warningSoft, warnText: colors.warningText,
  };
}

/** @deprecated Authentication layouts place content directly in a section. */
export function Float({ children, style }: { children: ReactNode; reduced: boolean; style?: ViewStyle }) {
  return <View style={style}>{children}</View>;
}

/** @deprecated Authentication layouts place content directly in a section. */
export function Rise({ children }: { index?: number; reduced: boolean; children: ReactNode }) {
  return <View>{children}</View>;
}

/** @deprecated Use AppButton. */
export function Btn({ primary, busy, ...props }: {
  label: string; icon?: NativeIconName; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; testID: string;
}) {
  return <AppButton {...props} variant={primary ? 'primary' : 'secondary'} loading={busy} />;
}

/** @deprecated Use AppButton with variant="text". */
export function TextButton({ brand: _brand, ...props }: {
  label: string; onPress: () => void; disabled?: boolean; brand?: boolean; testID: string;
}) {
  return <AppButton {...props} variant="text" />;
}

/** @deprecated Use AppTextField. */
export function SoftField({ icon, ...props }: TextInputProps & { label: string; testID: string; icon?: NativeIconName }) {
  return <AppTextField flush leadingIcon={icon} {...props} />;
}

/** @deprecated Use InlineError. */
export const SoftAlert = InlineError;

export function GhostBrandMark() {
  return <Image source={require('../../../../packages/ui/assets/brand/source/ghost-key-cutout.webp')} resizeMode="contain"
    style={local.brandMark} accessible={false} accessibilityIgnoresInvertColors />;
}

/** Authentication content uses the same page and field baselines as settings. */
export function AuthLayout({ art, artSize = size.emptyArt, title, subtitle, children, footer }: {
  art?: number; artSize?: number; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  const { colors, styles } = useMobileTheme();
  const { width, fontScale } = useWindowDimensions();
  const showArt = art && width >= 360 && fontScale < 1.3;
  const imageSize = Math.min(artSize, space[12] * 2);
  return (
    <AppPage safeArea="full">
      <View style={local.brand}>
        <GhostBrandMark />
        <Text style={[textStyle.nav, { color: colors.text }]}>My Secret</Text>
      </View>
      <View style={local.intro}>
        <View style={local.introText}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        {showArt ? <Image source={art} accessibilityIgnoresInvertColors accessible={false}
          style={{ width: imageSize, height: imageSize }} resizeMode="contain" /> : null}
      </View>
      <FieldGroup>{children}</FieldGroup>
      {footer && <View style={local.footer}>{footer}</View>}
    </AppPage>
  );
}

/** @deprecated Use AuthLayout. */
export const SoftScreen = AuthLayout;

const local = StyleSheet.create({
  brandMark: { width: size.brandMark, height: size.brandMark },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginBottom: space[6] },
  intro: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginBottom: space[6] },
  introText: { flex: 1, minWidth: 0, gap: space[2] },
  footer: { marginTop: space[6], gap: space[3] },
});
