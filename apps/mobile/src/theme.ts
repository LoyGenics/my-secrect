import { StyleSheet } from 'react-native';
import { darkTheme, lightTheme, typography, type ThemeName, type ThemeTokens } from '../../../packages/ui/src/tokens';

/**
 * Mobile theme — consumes the shared tokens, no duplicated literals.
 *
 * Mobile imports TOKENS ONLY (never @my-secrect/ui components or theme.ts:
 * those are DOM/React code and do not belong in React Native). Metro
 * already watches the repo root and resolves packages outside apps/mobile
 * (see metro.config.js), so this relative import works like the existing
 * imports of @my-secrect/core and crypto-adapters.
 *
 * Deliberate value changes vs the old hand-duplicated theme (all toward
 * the shared tokens, i.e. toward the desktop look):
 * - card: #151B23 -> surface #141519 (exact desktop card blend).
 * - input bg: #1B222C -> #18181B (desktop .input).
 * - accent: #6366F1 -> brand #4F46E5. White text on #6366F1 is 4.47:1,
 *   just below WCAG AA 4.5:1; white on #4F46E5 is 6.29:1. #6366F1 stays
 *   available as the focus/accent-decoration color in tokens.brand[500].
 * - danger: #EF4444 -> #DC2626 (white on #DC2626 is 4.83:1, AA).
 * - cardBorder/input border now derive from tokens.border.default.
 * - A light theme is available via getThemeColors('light'); the app is
 *   still dark by default — wiring the scheme switch is a later step.
 */

export interface MobileColors {
  bg: string;
  card: string;
  cardBorder: string;
  input: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  warn: string;
  warnSoft: string;
  ok: string;
  okSoft: string;
}

function toMobileColors(theme: ThemeTokens): MobileColors {
  return {
    bg: theme.background.base,
    card: theme.background.surface,
    cardBorder: theme.border.default,
    input: theme.background.input,
    text: theme.text.primary,
    muted: theme.text.muted,
    faint: theme.text.faint,
    accent: theme.brand.DEFAULT,
    accentSoft: theme.brand.soft,
    danger: theme.danger.DEFAULT,
    dangerSoft: theme.danger.soft,
    warn: theme.warning.DEFAULT,
    warnSoft: theme.warning.soft,
    ok: theme.success.DEFAULT,
    okSoft: theme.success.soft,
  };
}

/** Dark theme colors — the default. Same keys as before, so existing screens need no changes. */
export const colors: MobileColors = toMobileColors(darkTheme);

/** Light theme colors (opt-in; see getThemeColors). */
export const lightColors: MobileColors = toMobileColors(lightTheme);

/**
 * Resolve colors for a color scheme. `null`/`undefined` (no OS scheme
 * reported) falls back to dark, preserving the current look.
 */
export function getThemeColors(scheme: ThemeName | 'light' | 'dark' | null | undefined): MobileColors {
  return scheme === 'light' ? lightColors : colors;
}

/** Shared typography scale (from tokens) for screens that want it. */
export const type = typography;

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: 16 },
  card: { backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 16, padding: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 4 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, color: colors.text, fontSize: 16, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12 },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  primaryButton: { backgroundColor: colors.accent, borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  ghostButton: { borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  ghostButtonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  dangerButton: { backgroundColor: colors.danger, borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  chip: { backgroundColor: colors.accentSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { color: darkTheme.brand.softText, fontSize: 12, fontWeight: '600' },
});
