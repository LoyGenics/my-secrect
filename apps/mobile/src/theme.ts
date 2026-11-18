import { useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { darkTheme, lightTheme, radii, typography, type ThemeName, type ThemeTokens } from '../../../packages/ui/src/tokens';

/**
 * Mobile theme — the soft, light direction on the shared tokens
 * (packages/ui/src/tokens.ts), no duplicated literals.
 *
 * Mobile imports TOKENS ONLY plus the native entry of the design system
 * (packages/ui/src/native: Lucide icon wrapper, item-type tiles,
 * illustrations) — never the DOM components. Metro watches the repo root.
 *
 * Light is the default and, for now, the only finish on phones: the static
 * `colors` / `styles` exports (used by Lock, Settings, Security, Shares and
 * Sign-in) are light, and `useMobileTheme()` returns the same. The soft dark
 * theme exists in the tokens; wiring it needs those screens (and the shared
 * ItemRow / Field / MarkdownText / StrengthMeter components) to read
 * useMobileTheme() instead of the static exports — see FOLLOW_OS_APPEARANCE.
 * Type stays the platform's system font, in sentence case.
 */

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
    faint: theme.text.faint,
    accent: theme.brand.DEFAULT,
    onAccent: theme.text.onBrand,
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

/** Soft dark colours (not shown yet; see the header comment). */
export const darkColors: MobileColors = toMobileColors(darkTheme);

/** The static default for screens not yet on useMobileTheme(): light. */
export const colors: MobileColors = lightColors;

/** Resolve colours for a colour scheme; null/undefined falls back to light. */
export function getThemeColors(scheme: ThemeName | 'light' | 'dark' | null | undefined): MobileColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

/** Shared typography roles (five-step scale) for screens that want them. */
export const type = typography;

/** Small label: sentence case, semibold, quiet ink. */
const legend = { fontSize: 12, lineHeight: 16, fontWeight: '600' as const };

/** Soft elevation (iOS shadow + Android elevation) for cards. */
const softShadow = { shadowColor: '#14171c', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 };

export function createStyles(c: MobileColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    container: { flex: 1, padding: 16 },
    card: { backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.lg, padding: 16, ...softShadow },
    title: { color: c.text, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.5 },
    heading: { color: c.text, fontSize: 20, lineHeight: 26, fontWeight: '700' },
    subtitle: { color: c.muted, fontSize: 15, lineHeight: 22, marginTop: 4 },
    body: { color: c.text, fontSize: 15, lineHeight: 22 },
    small: { color: c.muted, fontSize: 13, lineHeight: 18 },
    label: { ...legend, fontSize: 13, color: c.muted, marginBottom: 6 },
    legend: { ...legend, color: c.muted },
    input: { backgroundColor: c.input, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.md, color: c.text, fontSize: 16, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12 },
    inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
    primaryButton: { backgroundColor: c.accent, borderRadius: radii.full, minHeight: 50, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
    primaryButtonText: { fontSize: 15, fontWeight: '700', color: c.onAccent },
    ghostButton: { backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.full, minHeight: 48, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 18 },
    ghostButtonText: { fontSize: 15, fontWeight: '600', color: c.text },
    dangerButton: { backgroundColor: c.danger, borderRadius: radii.full, minHeight: 50, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
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

/**
 * Follow the OS appearance. OFF: phones are light until the screens that
 * still import the static `colors` / `styles` (Lock, Settings, Security,
 * Shares, Sign-in, ItemRow, Field, MarkdownText, StrengthMeter) read
 * useMobileTheme() too — otherwise a dark phone would mix finishes.
 */
export const FOLLOW_OS_APPEARANCE = false;

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
