import { useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { darkTheme, lightTheme, radii, typography, type ThemeName, type ThemeTokens } from '../../../packages/ui/src/tokens';

/**
 * Mobile theme — "Precision Instrument" on the shared tokens
 * (packages/ui/src/tokens.ts), no duplicated literals.
 *
 * Mobile imports TOKENS ONLY plus the native entry of the design system
 * (packages/ui/src/native: Lucide icon wrapper, item-type modules,
 * illustrations) — never the DOM components. Metro watches the repo root.
 *
 * Phones behave like phones: the finish can follow the OS appearance
 * (useColorScheme; see FOLLOW_OS_APPEARANCE) and type stays the platform's
 * system font with printed UPPERCASE legends.
 * `useMobileTheme()` gives screens the live colours + styles; the static
 * `colors` / `styles` exports remain (graphite) for screens not yet migrated.
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
  highlight: string;
  keyEdge: string;
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
    highlight: theme.edge.highlight,
    keyEdge: theme.edge.key,
    ledOff: theme.led.off,
  };
}

/** Graphite colours — the static default for screens not yet on useMobileTheme(). */
export const colors: MobileColors = toMobileColors(darkTheme);

/** Aluminium colours. */
export const lightColors: MobileColors = toMobileColors(lightTheme);

/** Resolve colours for a colour scheme; null/undefined falls back to graphite. */
export function getThemeColors(scheme: ThemeName | 'light' | 'dark' | null | undefined): MobileColors {
  return scheme === 'light' ? lightColors : colors;
}

/** Shared typography roles (five-step scale) for screens that want them. */
export const type = typography;

/** Printed legend: uppercase, tracked, small — keys, tabs, section labels. */
const legend = { fontSize: 11, lineHeight: 14, fontWeight: '700' as const, letterSpacing: 0.9, textTransform: 'uppercase' as const };

export function createStyles(c: MobileColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    container: { flex: 1, padding: 16 },
    card: { backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.md, padding: 16, borderTopColor: c.highlight },
    title: { color: c.text, fontSize: 28, lineHeight: 32, fontWeight: '700' },
    heading: { color: c.text, fontSize: 20, lineHeight: 26, fontWeight: '700' },
    subtitle: { color: c.muted, fontSize: 15, lineHeight: 22, marginTop: 4 },
    body: { color: c.text, fontSize: 15, lineHeight: 22 },
    small: { color: c.muted, fontSize: 13, lineHeight: 18 },
    label: { ...legend, color: c.muted, marginBottom: 6 },
    legend: { ...legend, color: c.muted },
    input: { backgroundColor: c.input, borderColor: c.control, borderWidth: 1, borderRadius: radii.sm, color: c.text, fontSize: 16, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12 },
    inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
    primaryButton: { backgroundColor: c.accent, borderRadius: radii.sm, minHeight: 52, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16, borderBottomWidth: 2, borderBottomColor: '#B23A0E' },
    primaryButtonText: { ...legend, fontSize: 13, color: c.onAccent },
    ghostButton: { backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderBottomWidth: 2, borderBottomColor: c.keyEdge, borderRadius: radii.sm, minHeight: 48, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
    ghostButtonText: { ...legend, fontSize: 13, color: c.text },
    dangerButton: { backgroundColor: c.danger, borderRadius: radii.sm, minHeight: 52, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
    dangerButtonText: { ...legend, fontSize: 13, color: '#FFFFFF' },
    error: { color: c.dangerText, fontSize: 14, lineHeight: 20 },
    chip: { backgroundColor: c.input, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.xs, paddingHorizontal: 8, paddingVertical: 4, marginRight: 6, marginBottom: 6 },
    chipText: { color: c.secondary, fontSize: 12, fontWeight: '600' },
    led: { width: 8, height: 8, borderRadius: 4 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.card, borderColor: c.cardBorder, borderWidth: 1, borderRadius: radii.md, padding: 12, marginBottom: 8, minHeight: 56 },
  });
}

export type MobileStyles = ReturnType<typeof createStyles>;

/** Graphite styles — the static default (see useMobileTheme for live styles). */
export const styles = createStyles(colors);
const lightStyles = createStyles(lightColors);

/**
 * Follow the OS appearance. OFF until the screens owned elsewhere (Lock,
 * Settings, SignIn, Security, Shares) read useMobileTheme() too — until
 * then everything stays graphite so the app never mixes finishes. Flip to
 * true once they migrate; every screen on the hook switches with it.
 */
export const FOLLOW_OS_APPEARANCE = false;

/** Live theme: tokens, colours and styles for the current finish. */
export function useMobileTheme(): { theme: ThemeTokens; colors: MobileColors; styles: MobileStyles; scheme: ThemeName } {
  const os = useColorScheme();
  const scheme: ThemeName = FOLLOW_OS_APPEARANCE && os === 'light' ? 'light' : 'dark';
  return useMemo(
    () =>
      scheme === 'light'
        ? { theme: lightTheme, colors: lightColors, styles: lightStyles, scheme }
        : { theme: darkTheme, colors, styles, scheme },
    [scheme],
  );
}
