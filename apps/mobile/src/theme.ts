import { useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { darkTheme, lightTheme, radii, typography, type ThemeName, type ThemeTokens } from '../../../packages/ui/src/tokens';

/** Shared native palette. Every screen follows OS appearance; system typography
 * and grouped surfaces keep the vault readable on phone and tablet. */

export interface MobileColors {
  bg: string;
  card: string;
  cardBorder: string;
  input: string;
  text: string;
  secondary: string;
  muted: string;
  faint: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  danger: string;
  dangerText: string;
  dangerSoft: string;
  warn: string;
  warnText: string;
  warnSoft: string;
  ok: string;
  okText: string;
  okSoft: string;
  control: string;
  surface2: string;
  link: string;
  line: string;
  ledOff: string;
}

function toMobileColors(theme: ThemeTokens): MobileColors {
  return {
    bg: theme.background.base,
    card: theme.background.surface,
    cardBorder: theme.border.default,
    input: theme.background.input,
    text: theme.text.primary,
    secondary: theme.text.secondary,
    muted: theme.text.muted,
    faint: theme.text.muted,
    accent: '#D23F0C',
    onAccent: '#FFFFFF',
    accentSoft: theme.brand.soft,
    danger: theme.danger.DEFAULT,
    dangerText: theme.danger.softText,
    dangerSoft: theme.danger.soft,
    warn: theme.led.attention,
    warnText: theme.warning.text,
    warnSoft: theme.warning.soft,
    ok: theme.led.ok,
    okText: theme.success.text,
    okSoft: theme.success.soft,
    control: theme.border.control,
    surface2: theme.background.surface2,
    link: theme.text.link,
    line: theme.border.default,
    ledOff: theme.led.off,
  };
}

/** Light colours — the default. */
export const lightColors: MobileColors = toMobileColors(lightTheme);

/** Dark colours. */
export const darkColors: MobileColors = toMobileColors(darkTheme);

/** Static light palette for non-rendering consumers. */
export const colors: MobileColors = lightColors;

/** Resolve colours for a colour scheme; null/undefined falls back to light. */
export function getThemeColors(scheme: ThemeName | 'light' | 'dark' | null | undefined): MobileColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

/** Shared typography roles (five-step scale) for screens that want them. */
export const type = typography;

/** Small label: sentence case, semibold, quiet ink. */
const legend = { fontSize: 12, lineHeight: 16, fontWeight: '600' as const };

export function createStyles(c: MobileColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    container: { flex: 1, padding: 16 },
    card: { backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderRadius: 14, padding: 16 },
    title: { color: c.text, fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.5 },
    heading: { color: c.text, fontSize: 20, lineHeight: 26, fontWeight: '700' },
    subtitle: { color: c.muted, fontSize: 15, lineHeight: 22, marginTop: 4 },
    body: { color: c.text, fontSize: 15, lineHeight: 22 },
    small: { color: c.muted, fontSize: 13, lineHeight: 18 },
    label: { ...legend, fontSize: 13, color: c.muted, marginBottom: 6 },
    legend: { ...legend, color: c.muted },
    input: { backgroundColor: c.input, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.md, color: c.text, fontSize: 16, minHeight: 50, paddingHorizontal: 14, paddingVertical: 13 },
    inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
    primaryButton: { backgroundColor: c.accent, borderRadius: 12, minHeight: 50, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
    primaryButtonText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
    ghostButton: { backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 18 },
    ghostButtonText: { fontSize: 15, fontWeight: '600', color: c.text },
    dangerButton: { backgroundColor: c.danger, borderRadius: 12, minHeight: 50, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
    dangerButtonText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
    error: { color: c.dangerText, fontSize: 14, lineHeight: 20 },
    chip: { backgroundColor: c.surface2, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 4, marginRight: 6, marginBottom: 6 },
    chipText: { color: c.secondary, fontSize: 12, fontWeight: '600' },
    led: { width: 8, height: 8, borderRadius: 4 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.card, borderRadius: radii.md, padding: 10, marginBottom: 4, minHeight: 64 },
  });
}

export type MobileStyles = ReturnType<typeof createStyles>;

/** The static default styles (light); see useMobileTheme for live styles. */
export const styles = createStyles(colors);

/** Follow the device appearance across the whole mobile app. */
export const FOLLOW_OS_APPEARANCE = true;

/** Live theme: tokens, colours and styles for the current finish. */
export function useMobileTheme(): { theme: ThemeTokens; colors: MobileColors; styles: MobileStyles; scheme: ThemeName } {
  const os = useColorScheme();
  const scheme: ThemeName = FOLLOW_OS_APPEARANCE && os === 'dark' ? 'dark' : 'light';
  return useMemo(
    () =>
      scheme === 'dark'
        ? { theme: darkTheme, colors: darkColors, styles: createStyles(darkColors), scheme }
        : { theme: lightTheme, colors, styles, scheme },
    [scheme],
  );
}
