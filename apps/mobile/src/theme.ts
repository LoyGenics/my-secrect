import { StyleSheet } from 'react-native';
import { darkTheme, lightTheme, type ThemeName, type ThemeTokens } from '../../../packages/ui/src/tokens';
import { useResolvedAppearance } from './ui/AppearanceProvider';
import { mobileColorRoles, radius, size, space, textStyle } from './ui/tokens';

function toMobileColors(theme: ThemeTokens) {
  const roles = mobileColorRoles(theme);
  // Existing consumers share the same roles while they migrate to semantic names.
  return {
    ...roles,
    bg: roles.canvas,
    card: roles.surface,
    cardBorder: roles.border,
    input: roles.inputSurface,
    secondary: roles.secondaryText,
    muted: roles.mutedText,
    faint: roles.mutedText,
    accent: roles.primaryFill,
    onAccent: roles.onPrimary,
    accentSoft: roles.selection,
    warn: theme.led.attention,
    warnText: roles.warningText,
    warnSoft: roles.warningSoft,
    ok: theme.led.ok,
    okText: roles.successText,
    okSoft: roles.successSoft,
    control: roles.controlBorder,
    surface2: roles.surfaceMuted,
    link: roles.primaryTextLink,
    line: roles.border,
    ledOff: theme.led.off,
  };
}

export type MobileColors = ReturnType<typeof toMobileColors>;
export const lightColors = toMobileColors(lightTheme);
export const darkColors = toMobileColors(darkTheme);
/** @deprecated Use the live mobile theme. */
export const colors = lightColors;
export const type = textStyle;

export function getThemeColors(scheme: ThemeName | null | undefined): MobileColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

export function createStyles(c: MobileColors) {
  const action = { borderRadius: radius.button, minHeight: size.action, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: space[2], paddingHorizontal: space[4], paddingVertical: space[2] } as const;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    // Legacy consumers can migrate their wrapper to AppPage without a visual jump.
    container: { flex: 1, padding: space[4] },
    card: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.surface, padding: space[4] },
    title: { ...textStyle.display, color: c.text },
    heading: { ...textStyle.title, color: c.text },
    subtitle: { ...textStyle.helper, color: c.secondaryText },
    body: { ...textStyle.body, color: c.text },
    small: { ...textStyle.helper, color: c.mutedText },
    label: { ...textStyle.helper, fontWeight: '600', color: c.secondaryText, marginBottom: space[2] },
    legend: { ...textStyle.caption, fontWeight: '600', color: c.secondaryText },
    inputShell: { backgroundColor: c.inputSurface, borderColor: c.controlBorder, borderWidth: 1, borderRadius: radius.field, minHeight: size.field, flexDirection: 'row', alignItems: 'center' },
    inputFocused: { borderColor: c.focus, backgroundColor: c.surface },
    input: { ...textStyle.body, flex: 1, minWidth: 0, color: c.text, paddingHorizontal: space[3], paddingVertical: space[3] },
    inputMultiline: { minHeight: space[12] * 2, textAlignVertical: 'top' },
    iconButton: { width: size.touch, height: size.touch, flexShrink: 0, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' },
    primaryButton: { ...action, backgroundColor: c.primaryFill },
    primaryButtonText: { ...textStyle.item, color: c.onPrimary },
    ghostButton: { ...action, backgroundColor: c.surface, borderColor: c.controlBorder, borderWidth: 1 },
    ghostButtonText: { ...textStyle.item, color: c.text },
    dangerButton: { ...action, backgroundColor: c.danger },
    dangerButtonText: { ...textStyle.item, color: c.onPrimary },
    error: { ...textStyle.helper, color: c.dangerText },
    chip: { backgroundColor: c.surfaceMuted, borderColor: c.border, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space[3], paddingVertical: space[1], marginRight: space[2], marginBottom: space[2] },
    chipText: { ...textStyle.caption, color: c.secondaryText, fontWeight: '600' },
    led: { width: space[2], height: space[2], borderRadius: radius.full },
    row: { flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: c.surface, borderRadius: radius.surface, padding: space[3], marginBottom: space[1], minHeight: size.settingsRow },
  });
}

export type MobileStyles = ReturnType<typeof createStyles>;
/** @deprecated Use useMobileTheme within components. */
export const styles = createStyles(colors);

const mobileThemes = {
  light: { theme: lightTheme, colors: lightColors, styles, scheme: 'light' },
  dark: { theme: darkTheme, colors: darkColors, styles: createStyles(darkColors), scheme: 'dark' },
} as const;

export function useMobileTheme(): { theme: ThemeTokens; colors: MobileColors; styles: MobileStyles; scheme: ThemeName } {
  return mobileThemes[useResolvedAppearance()];
}
