/**
 * My Secret design tokens — the single source of truth for color, type,
 * spacing, radius, shadow, border, motion, breakpoints and density.
 *
 * Platform-neutral: this file imports nothing from React, the DOM or
 * React Native, so desktop, web AND mobile can all import it. Mobile
 * consumes these values only (see apps/mobile/src/theme.ts); DOM components
 * consume the same values through CSS variables (see tokens.css).
 *
 * Origin: the Phase A audit. Desktop was the de-facto source (dark-only,
 * bg #0B0F14, zinc-100 text, indigo #6366F1 accent) and its values are
 * preserved exactly in the dark theme. Web's sky accent was drift, not a
 * decision, and is removed (see apps/web/src/index.css).
 *
 * CONTRAST — WCAG 2.2 AA targets, computed from relative luminance
 * (sRGB), NOT verified in a browser (no browser test has been run):
 *
 *   Dark theme
 *   - text.primary   #F4F4F5 on bg.base #0B0F14        17.49:1 (AAA)
 *   - text.secondary #D4D4D8 on bg.base                13.00:1 (AAA)
 *   - text.muted     #A1A1AA on bg.base                 7.50:1 (AAA)
 *   - text.muted     #A1A1AA on input bg #18181B        6.91:1 (AAA)
 *   - text.faint     #71717A on bg.base                 3.98:1 — FAILS 4.5:1
 *     for normal text. RESTRICTED to large text (>= 18pt / 24px, or bold
 *     >= 14pt) and non-text decoration only, where the bar is 3:1.
 *     Never use it for body copy, labels or placeholders.
 *   - on-brand white #FFFFFF on brand.600 #4F46E5        6.29:1 (AA)
 *   - brand.500 #6366F1 with white text                  4.47:1 — just
 *     BELOW 4.5:1. brand.500 is therefore NEVER a text-on-brand color.
 *     It is used for focus rings, large-text accents and decoration only.
 *     Primary buttons use brand.600 (desktop already did).
 *   - focus ring brand.500 vs dark bg                    4.30:1 (> 3:1
 *     non-text minimum, WCAG 1.4.11 / 2.4.7)
 *   - danger text #FECACA on danger bg (dark)           12.39:1 (AAA)
 *   - success #34D399 / warning #FBBF24 / danger #F87171 on dark bg
 *     are 10.00 / 11.51 / 6.95:1 — all pass AA as text.
 *
 *   Light theme
 *   - text.primary   #18181B on #FFFFFF                 17.72:1 (AAA)
 *   - text.secondary #3F3F46 on #FFFFFF                 10.44:1 (AAA)
 *   - text.muted     #52525B on #FFFFFF                  7.73:1 (AAA)
 *   - text.faint     #71717A on #FFFFFF                  4.83:1 (AA) — but
 *     only 4.40:1 on surface #F4F4F5, so the same restriction applies:
 *     large text / decoration only, never body copy on surfaces.
 *   - on-brand white on brand.600                         6.29:1 (AA)
 *   - brand.700 #4338CA on #FFFFFF (links)                7.90:1 (AAA)
 *   - focus ring brand.600 vs white                      6.29:1 (> 3:1)
 *
 * These ratios are arithmetic on the hex values above. A real AA claim
 * still needs a browser check (rendered text, real backgrounds, zoom and
 * forced-colors mode) — that check has NOT been run.
 */

// ---------------------------------------------------------------------------
// Raw scales (Tailwind-compatible values, kept so existing Tailwind code
// and the new tokens describe the same colors)
// ---------------------------------------------------------------------------

export const brand = {
  50: '#EEF2FF',
  100: '#E0E7FF',
  200: '#C7D2FE',
  300: '#A5B4FC',
  400: '#818CF8',
  /** Focus rings / large-text accents / decoration ONLY — 4.47:1 with white. */
  500: '#6366F1',
  /** The text-on-brand color: white on 600 is 6.29:1. Primary buttons. */
  600: '#4F46E5',
  /** Links on light backgrounds: 7.90:1 on white. */
  700: '#4338CA',
  800: '#3730A3',
  900: '#312E81',
  950: '#1E1B4B',
} as const;

export const neutral = {
  50: '#FAFAFA',
  100: '#F4F4F5',
  200: '#E4E4E7',
  300: '#D4D4D8',
  400: '#A1A1AA',
  /** Restricted: large text / decoration only (see header). */
  500: '#71717A',
  600: '#52525B',
  700: '#3F3F46',
  800: '#27272A',
  900: '#18181B',
  950: '#09090B',
} as const;

export const semantic = {
  success: '#10B981',
  successTextDark: '#34D399',
  successTextLight: '#047857',
  warning: '#F59E0B',
  warningTextDark: '#FBBF24',
  warningTextLight: '#B45309',
  danger: '#DC2626',
  dangerTextDark: '#F87171',
  dangerTextLight: '#B91C1C',
  dangerSoftDark: '#FECACA',
} as const;

// ---------------------------------------------------------------------------
// Semantic themes
// ---------------------------------------------------------------------------

export interface ThemeTokens {
  colorScheme: 'light' | 'dark';
  background: { base: string; surface: string; raised: string; sunken: string; input: string };
  text: { primary: string; secondary: string; muted: string; faint: string; onBrand: string; onDanger: string; link: string };
  border: { default: string; strong: string; subtle: string };
  brand: { DEFAULT: string; hover: string; active: string; soft: string; softText: string; focus: string };
  danger: { DEFAULT: string; hover: string; soft: string; softText: string; border: string };
  success: { DEFAULT: string; text: string; soft: string };
  warning: { DEFAULT: string; text: string; soft: string };
  focus: { ring: string; width: string; offset: string };
}

/** Dark theme — preserves the desktop look exactly. Default theme. */
export const darkTheme: ThemeTokens = {
  colorScheme: 'dark',
  background: {
    base: '#0B0F14',
    // Exact blend of desktop's bg-zinc-900/70 card over #0B0F14.
    surface: '#141519',
    raised: '#1B222C',
    sunken: '#080B0F',
    // Desktop .input bg-zinc-900. Mobile previously used #1B222C here;
    // it now adopts this value (one-token change, see mobile theme.ts).
    input: '#18181B',
  },
  text: {
    primary: '#F4F4F5',
    secondary: '#D4D4D8',
    muted: '#A1A1AA',
    faint: '#71717A',
    onBrand: '#FFFFFF',
    onDanger: '#FFFFFF',
    link: '#A5B4FC',
  },
  border: { default: '#27272A', strong: '#3F3F46', subtle: '#1F1F23' },
  brand: {
    DEFAULT: '#4F46E5',
    hover: '#6366F1',
    active: '#4338CA',
    soft: 'rgba(99, 102, 241, 0.20)',
    softText: '#C7D2FE',
    focus: '#6366F1',
  },
  danger: {
    DEFAULT: '#DC2626',
    hover: '#EF4444',
    soft: 'rgba(220, 38, 38, 0.18)',
    softText: '#FECACA',
    border: 'rgba(220, 38, 38, 0.60)',
  },
  success: { DEFAULT: '#10B981', text: '#34D399', soft: 'rgba(16, 185, 129, 0.15)' },
  warning: { DEFAULT: '#F59E0B', text: '#FBBF24', soft: 'rgba(245, 158, 11, 0.15)' },
  focus: { ring: '#6366F1', width: '2px', offset: '2px' },
};

/** Light theme — same brand, inverted surfaces. Opt-in via data-theme="light". */
export const lightTheme: ThemeTokens = {
  colorScheme: 'light',
  background: {
    base: '#FFFFFF',
    surface: '#F4F4F5',
    raised: '#FFFFFF',
    sunken: '#E4E4E7',
    input: '#FFFFFF',
  },
  text: {
    primary: '#18181B',
    secondary: '#3F3F46',
    muted: '#52525B',
    faint: '#71717A',
    onBrand: '#FFFFFF',
    onDanger: '#FFFFFF',
    link: '#4338CA',
  },
  border: { default: '#D4D4D8', strong: '#A1A1AA', subtle: '#E4E4E7' },
  brand: {
    DEFAULT: '#4F46E5',
    hover: '#4338CA',
    active: '#3730A3',
    soft: 'rgba(79, 70, 229, 0.10)',
    softText: '#4338CA',
    focus: '#4F46E5',
  },
  danger: {
    DEFAULT: '#DC2626',
    hover: '#B91C1C',
    soft: 'rgba(220, 38, 38, 0.08)',
    softText: '#B91C1C',
    border: 'rgba(220, 38, 38, 0.50)',
  },
  success: { DEFAULT: '#059669', text: '#047857', soft: 'rgba(5, 150, 105, 0.10)' },
  warning: { DEFAULT: '#D97706', text: '#B45309', soft: 'rgba(217, 119, 6, 0.10)' },
  focus: { ring: '#4F46E5', width: '2px', offset: '2px' },
};

export const themes = { light: lightTheme, dark: darkTheme } as const;
export type ThemeName = keyof typeof themes;

// ---------------------------------------------------------------------------
// Typography, spacing, radii, shadows, motion, breakpoints, density
// ---------------------------------------------------------------------------

export const fontFamily = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
} as const;

export const typography = {
  display: { fontSize: 32, lineHeight: 40, fontWeight: 700, letterSpacing: '-0.01em' },
  title: { fontSize: 24, lineHeight: 32, fontWeight: 700, letterSpacing: '-0.01em' },
  heading: { fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: '0em' },
  subheading: { fontSize: 16, lineHeight: 24, fontWeight: 600, letterSpacing: '0em' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: 400, letterSpacing: '0em' },
  bodySmall: { fontSize: 14, lineHeight: 20, fontWeight: 400, letterSpacing: '0em' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: 500, letterSpacing: '0em' },
  /** Desktop `.label`: uppercase, tracking-wide, xs. */
  label: { fontSize: 12, lineHeight: 16, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' as const },
  mono: { fontSize: 14, lineHeight: 20, fontWeight: 400, letterSpacing: '0em' },
} as const;

export type TypographyKey = keyof typeof typography;

/** 4px base scale. */
export const spacing = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64, 20: 80, 24: 96,
} as const;

export const radii = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

export const shadows = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.20)',
  md: '0 4px 12px rgba(0, 0, 0, 0.30)',
  lg: '0 12px 32px rgba(0, 0, 0, 0.45)',
  overlay: '0 16px 48px rgba(0, 0, 0, 0.55)',
} as const;

export const borders = { width: { hairline: 1, default: 1, strong: 2 } } as const;

export const motion = {
  duration: { fast: 120, base: 200, slow: 320 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
    accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  },
  /** Honor `prefers-reduced-motion` — see tokens.css, which disables
   *  transitions/animations under this media query. */
  reduceMotionQuery: '(prefers-reduced-motion: reduce)',
} as const;

export const breakpoints = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;

/**
 * Density. `comfortable` is the default: 40px desktop controls, 48px
 * minimum touch targets on mobile (Apple HIG 44pt / Material 48dp — we
 * use 48px as the floor). `compact` is 32px controls, pointer-fine
 * (desktop mouse/trackpad) only; never use it where touch is primary.
 */
export const density = {
  comfortable: { controlHeight: 40, controlHeightTouch: 48, controlPaddingX: 12, gap: 8 },
  compact: { controlHeight: 32, controlHeightTouch: 44, controlPaddingX: 8, gap: 6 },
} as const;

export type DensityName = keyof typeof density;

/** Minimum interactive target: WCAG 2.2 AA target size is 24x24 CSS px;
 *  Apple HIG / Material guidance is 44-48px. We ship 44px as the floor. */
export const minTouchTarget = 44;

/** Default export surface: everything a consumer needs in one object. */
export const tokens = {
  brand,
  neutral,
  semantic,
  themes,
  dark: darkTheme,
  light: lightTheme,
  fontFamily,
  typography,
  spacing,
  radii,
  shadows,
  borders,
  motion,
  breakpoints,
  density,
  minTouchTarget,
} as const;

export type Tokens = typeof tokens;
