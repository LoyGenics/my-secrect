import { StyleSheet } from 'react-native';
import { darkTheme, lightTheme, type ThemeName, type ThemeTokens } from '../../../packages/ui/src/tokens';
import { useResolvedAppearance } from './ui/AppearanceProvider';
import { monoFamily } from './ui/fonts';
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

/** Secrets (16/24), keys and card faces (18/24) and one-time codes (24/32) in the platform monospace. */
export const monoText = {
  secret: { ...textStyle.secret, fontFamily: monoFamily },
  key: { ...textStyle.key, fontFamily: monoFamily },
  code: { ...textStyle.code, fontFamily: monoFamily },
} as const;

export function getThemeColors(scheme: ThemeName | null | undefined): MobileColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

export function createStyles(c: MobileColors) {
  const action = { borderRadius: radius.button, minHeight: size.action, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: space[2], paddingHorizontal: space[6], paddingVertical: space[2] } as const;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    // Legacy consumers can migrate their wrapper to AppPage without a visual jump.
    container: { flex: 1, padding: space[4] },
    card: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.surface, padding: space[4] },
    title: { ...textStyle.display, color: c.text },
    heading: { ...textStyle.title, color: c.text },
    subtitle: { ...textStyle.body, color: c.secondaryText },
    body: { ...textStyle.body, color: c.text },
    small: { ...textStyle.caption, color: c.secondaryText },
    label: { ...textStyle.label, color: c.secondaryText, marginBottom: space[1] },
    legend: { ...textStyle.label, color: c.secondaryText },
    // Body fields are an underline only; cover fields (sign-in, search) add inputBoxed.
    inputShell: { borderBottomColor: c.controlBorder, borderBottomWidth: 1, minHeight: size.field, flexDirection: 'row', alignItems: 'center' },
    inputFocused: { borderBottomColor: c.focus, borderBottomWidth: 2 },
    // borderBottomColor beats borderColor in RN, so every edge state sets both.
    inputBoxed: { backgroundColor: c.surface, borderColor: c.coverFieldEdge, borderBottomColor: c.coverFieldEdge, borderWidth: 1, borderBottomWidth: 1, borderRadius: radius.coverField, paddingHorizontal: space[4] },
    inputBoxedFocused: { borderColor: c.focus, borderBottomColor: c.focus, borderWidth: 2, borderBottomWidth: 2, paddingHorizontal: space[4] - 1 },
    input: { ...textStyle.value, flex: 1, minWidth: 0, color: c.text, paddingHorizontal: 0, paddingVertical: space[3] },
    inputMultiline: { minHeight: space[12] * 2, textAlignVertical: 'top' },
    iconButton: { width: size.touch, height: size.touch, flexShrink: 0, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
    primaryButton: { ...action, backgroundColor: c.primaryFill },
    primaryButtonText: { ...textStyle.strong, color: c.onPrimary },
    ghostButton: { ...action, backgroundColor: c.sunken },
    ghostButtonText: { ...textStyle.strong, color: c.text },
    dangerButton: { ...action, backgroundColor: c.danger },
    dangerButtonText: { ...textStyle.strong, color: c.onDanger },
    error: { ...textStyle.caption, color: c.dangerText },
    chip: { backgroundColor: c.sunken, borderRadius: radius.full, paddingHorizontal: space[4], paddingVertical: space[1], marginRight: space[2], marginBottom: space[2] },
    chipText: { ...textStyle.control, color: c.text },
    led: { width: space[2], height: space[2], borderRadius: radius.full },
    row: { flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: c.surface, minHeight: size.settingsRow, paddingVertical: space[3], borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
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
