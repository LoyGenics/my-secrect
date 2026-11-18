/**
 * My Secret design tokens — "Precision Instrument", softened.
 *
 * The vault is still a precisely made personal object with two finishes
 * (light aluminium — the default — and dark graphite), but the user found
 * the first build too mechanical, so the machining is gone: plates are soft
 * cards (light: white on a warm body with a gentle shadow; dark: a hairline
 * instead of a shadow), keys are rounded buttons with sentence-case labels,
 * inputs are light fields, LEDs are small status dots. Colour is still
 * signal only: one orange key for the primary action, green / amber / red
 * status dots, and the clay pastels for item-type tiles.
 * Direction contract: apps/desktop/.impeccable/surfaces/apps-desktop-src-app-tsx.md
 *
 * This file is the ONE place to change palette, type, radii, motion:
 * tokens.css is generated from it (`npm --workspace @my-secrect/ui run tokens`,
 * enforced by tests/tokens-sync.test.ts). Platform-neutral: no React, DOM or
 * React Native imports, so web, desktop and mobile all read it.
 *
 * CONTRAST (WCAG 2.2 AA, relative luminance; the rendered result is also
 * checked by axe-core in tests/a11y-web, both finishes):
 *
 *   Aluminium (light)                         Graphite (dark)
 *   ink #1F1E1C on card #FFFFFF    16.66:1    ink #EDECE8 on card #1E1F22   13.94:1
 *   ink on body #F3F1ED            14.77:1    ink on body #151618           15.32:1
 *   muted #615E58 on body           5.73:1    muted #A3A29D on card          6.44:1
 *   muted on chip fill #EEEBE6      5.43:1    muted on chip fill #2A2B2F     5.53:1
 *   control border on card          3.57:1    control border on card         3.33:1
 *   ink on orange key               5.37:1    ink on orange key              5.37:1
 *   white on danger key #C42F36     5.52:1    white on danger key            5.52:1
 *   danger text #B42328 on body     5.80:1    danger text #FF8A8D on card    7.28:1
 *   warning text #8A5A00 on body    5.25:1    warning text #F2A93B on card   8.25:1
 *   success text #1A6E3E on card    6.28:1    success text #5ED18E on card   8.62:1
 *   focus ring #D4460E on body      3.98:1    focus ring #FF5B1F on body     5.84:1
 *
 * White on orange is 3.10:1, so labels on orange are ink, never white. The
 * bright orange is 2.44:1 on the light body, so the light finish draws focus
 * with a deeper orange (`focus.ring`, >= 3:1 on body and cards). Status-dot
 * colours are never text; status text uses the `*.text` tokens with a dot
 * beside it.
 */

// ---------------------------------------------------------------------------
// Semantic themes
// ---------------------------------------------------------------------------

/** Item types (VaultItem `type` in packages/core). Each owns one tile colour and one Lucide glyph. */
export const itemTypes = [
  'login', 'passkey', 'bank_account', 'card', 'identity', 'ssh_key',
  'api_key', 'secure_note', 'document', 'media', 'collection', 'custom',
] as const;
export type ItemTypeKey = (typeof itemTypes)[number];

export interface ThemeTokens {
  colorScheme: 'light' | 'dark';
  /** base = the app body; surface = cards; raised = buttons and selected segments; sunken = tracks; input = text fields; muted = hover fills and chips. */
  background: { base: string; surface: string; raised: string; sunken: string; input: string; muted: string };
  /** onModule: ink on item-type tiles (pastel clay fills in both finishes). */
  text: { primary: string; secondary: string; muted: string; faint: string; onBrand: string; onDanger: string; onModule: string; link: string };
  /** default = dividers; card = the card edge (transparent where the shadow carries it); control = the only border meeting 3:1 (fields, switches). */
  border: { default: string; strong: string; subtle: string; control: string; card: string };
  /** The orange key: primary action only. */
  brand: { DEFAULT: string; hover: string; active: string; soft: string; softText: string; focus: string };
  danger: { DEFAULT: string; hover: string; soft: string; softText: string; border: string };
  success: { DEFAULT: string; text: string; soft: string };
  warning: { DEFAULT: string; text: string; soft: string };
  /** Status-dot colours (dots and meter segments only, never text). `off` is an unlit dot. */
  led: { ok: string; attention: string; danger: string; active: string; off: string };
  /** ring = the focus outline (>= 3:1 on body and cards). */
  focus: { ring: string; width: string; offset: string };
  /**
   * One tile colour per item type, from the clay illustration palette
   * (sky, mint, butter, coral, lavender, tangerine). Pastel in both finishes,
   * printed with `text.onModule` ink (>= 10:1 on every fill).
   */
  itemType: Record<ItemTypeKey, string>;
  /** card = resting card elevation (none on graphite, where `border.card` draws the edge). */
  shadow: { card: string; sm: string; md: string; lg: string; overlay: string };
}

/** Graphite — the dark finish. */
export const darkTheme: ThemeTokens = {
  colorScheme: 'dark',
  background: {
    base: '#151618',
    surface: '#1E1F22',
    raised: '#26272B',
    sunken: '#121315',
    input: '#1A1B1E',
    muted: '#2A2B2F',
  },
  text: {
    primary: '#EDECE8',
    secondary: '#CBCAC5',
    muted: '#A3A29D',
    faint: '#6F6E6A',
    onBrand: '#1F1E1C',
    onDanger: '#FFFFFF',
    onModule: '#1F1E1C',
    link: '#EDECE8',
  },
  border: { default: '#2C2D31', strong: '#3A3B40', subtle: '#242528', control: '#6F7074', card: '#2A2B2F' },
  brand: {
    DEFAULT: '#FF5B1F',
    hover: '#FF7A45',
    active: '#F04E14',
    soft: 'rgba(255, 91, 31, 0.16)',
    softText: '#FFB59A',
    focus: '#FF5B1F',
  },
  danger: {
    DEFAULT: '#C42F36',
    hover: '#B3292F',
    soft: 'rgba(229, 72, 77, 0.16)',
    softText: '#FF8A8D',
    border: 'rgba(229, 72, 77, 0.45)',
  },
  success: { DEFAULT: '#35B46A', text: '#5ED18E', soft: 'rgba(53, 180, 106, 0.14)' },
  warning: { DEFAULT: '#F2A93B', text: '#F2A93B', soft: 'rgba(242, 169, 59, 0.14)' },
  led: { ok: '#35B46A', attention: '#F2A93B', danger: '#E5484D', active: '#FF5B1F', off: '#3A3B40' },
  focus: { ring: '#FF5B1F', width: '2px', offset: '2px' },
  itemType: {
    login: '#AFCFEE',
    passkey: '#A9DBC4',
    bank_account: '#EBD68C',
    card: '#EDB5AA',
    identity: '#C9BDEA',
    ssh_key: '#9CC1E6',
    api_key: '#9BD2B9',
    secure_note: '#E6C96B',
    document: '#F0BE98',
    media: '#E9A7B8',
    collection: '#BAAAE6',
    custom: '#EECAAB',
  },
  shadow: {
    card: 'none',
    sm: '0 1px 2px rgba(0, 0, 0, 0.30)',
    md: '0 4px 16px rgba(0, 0, 0, 0.32)',
    lg: '0 12px 32px rgba(0, 0, 0, 0.40)',
    overlay: '0 24px 64px rgba(0, 0, 0, 0.50)',
  },
};

/** Aluminium — the light finish. Default. */
export const lightTheme: ThemeTokens = {
  colorScheme: 'light',
  background: {
    base: '#F3F1ED',
    surface: '#FFFFFF',
    raised: '#FFFFFF',
    sunken: '#ECE9E4',
    input: '#FFFFFF',
    muted: '#EEEBE6',
  },
  text: {
    primary: '#1F1E1C',
    secondary: '#45433F',
    muted: '#615E58',
    faint: '#9C9890',
    onBrand: '#1F1E1C',
    onDanger: '#FFFFFF',
    onModule: '#1F1E1C',
    link: '#1F1E1C',
  },
  border: { default: '#E5E1DA', strong: '#D3CEC6', subtle: '#EDEAE5', control: '#8C877F', card: 'transparent' },
  brand: {
    DEFAULT: '#FF5B1F',
    hover: '#FF6E36',
    active: '#F04E14',
    soft: 'rgba(255, 91, 31, 0.12)',
    softText: '#1F1E1C',
    focus: '#D4460E',
  },
  danger: {
    DEFAULT: '#C42F36',
    hover: '#B3292F',
    soft: 'rgba(229, 72, 77, 0.10)',
    softText: '#B42328',
    border: 'rgba(196, 47, 54, 0.40)',
  },
  success: { DEFAULT: '#35B46A', text: '#1A6E3E', soft: 'rgba(53, 180, 106, 0.12)' },
  warning: { DEFAULT: '#F2A93B', text: '#8A5A00', soft: 'rgba(242, 169, 59, 0.16)' },
  led: { ok: '#35B46A', attention: '#F2A93B', danger: '#E5484D', active: '#FF5B1F', off: '#D3CEC6' },
  focus: { ring: '#D4460E', width: '2px', offset: '2px' },
  itemType: {
    login: '#D6E9FB',
    passkey: '#D3F0E3',
    bank_account: '#FBEFC2',
    card: '#FADAD3',
    identity: '#E7E0F8',
    ssh_key: '#C7DFF4',
    api_key: '#C4E9D7',
    secure_note: '#F7E5A8',
    document: '#FCDFCA',
    media: '#F8CDD8',
    collection: '#DDD2F4',
    custom: '#FDE9DA',
  },
  shadow: {
    card: '0 1px 2px rgba(41, 33, 20, 0.05), 0 2px 10px rgba(41, 33, 20, 0.05)',
    sm: '0 1px 2px rgba(41, 33, 20, 0.08)',
    md: '0 2px 6px rgba(41, 33, 20, 0.06), 0 8px 24px rgba(41, 33, 20, 0.08)',
    lg: '0 4px 12px rgba(41, 33, 20, 0.06), 0 16px 40px rgba(41, 33, 20, 0.12)',
    overlay: '0 8px 24px rgba(41, 33, 20, 0.10), 0 24px 64px rgba(41, 33, 20, 0.18)',
  },
};

export const themes = { light: lightTheme, dark: darkTheme } as const;
export type ThemeName = keyof typeof themes;

/** The finish a new user sees before choosing one. */
export const DEFAULT_THEME: ThemeName = 'light';

// ---------------------------------------------------------------------------
// Typography, spacing, radii, motion, breakpoints, density
// ---------------------------------------------------------------------------

/**
 * `sans` = Be Vietnam Pro (OFL, self-hosted via @fontsource, Vietnamese
 * subset; drawn in Vietnam for stacked diacritics) for every interface
 * string — body, labels, buttons and headings. `mono` = secret values,
 * keys and hashes only (data, not costume). Mobile keeps the platform font.
 */
export const fontFamily = {
  sans: "'Be Vietnam Pro', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/**
 * The strict five-step scale: [font-size, line-height] px. Every component
 * reads --ms-text-<step> / --ms-leading-<step>; there is no sixth size.
 * legend = small labels, counts and captions (sentence case); sm = secondary
 * lines; md = body, fields, list titles; lg = view and detail titles;
 * xl = the lock-screen wordmark and the Watchtower readout.
 */
export const textScale = {
  legend: [12, 16],
  sm: [13, 20],
  md: [15, 24],
  lg: [20, 28],
  xl: [28, 34],
} as const;

export type TextStep = keyof typeof textScale;

/** Role presets on the five-step scale (mobile reads these directly). */
export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: 600, letterSpacing: '-0.01em' },
  title: { fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: '-0.01em' },
  body: { fontSize: 15, lineHeight: 24, fontWeight: 400, letterSpacing: '0em' },
  secondary: { fontSize: 13, lineHeight: 20, fontWeight: 400, letterSpacing: '0em' },
  legend: { fontSize: 12, lineHeight: 16, fontWeight: 600, letterSpacing: '0em' },
  mono: { fontSize: 13, lineHeight: 20, fontWeight: 400, letterSpacing: '0em' },
} as const;

export type TypographyKey = keyof typeof typography;

/** 4px base scale. */
export const spacing = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64,
} as const;

/** xs: chips' inner marks, small tiles; sm: buttons, fields, rows; md: cards; lg: dialogs, sheets and the lock card. */
export const radii = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 20,
  full: 9999,
} as const;

/** Dark-finish shadows (kept for existing imports); per-theme values live in `ThemeTokens.shadow`. */
export const shadows = darkTheme.shadow;

export const borders = { width: { hairline: 1, default: 1, strong: 2 } } as const;

/**
 * Smooth motion: 180–260 ms ease-out, no bounce, no detents. `turn` is the
 * unlock moment (status dot settles green, the lock card fades up and away).
 * Under reduced motion components swap movement for an opacity crossfade
 * (or nothing) — see components.css.
 */
export const motion = {
  duration: { fast: 180, base: 220, slow: 260, turn: 320 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  reduceMotionQuery: '(prefers-reduced-motion: reduce)',
} as const;

/** Layout breakpoints: phone < 768 <= tablet < 1024 <= desktop. */
export const breakpoints = { sm: 480, md: 768, lg: 1024, xl: 1280 } as const;

/**
 * Density. Desktop buttons and fields are 40px (pointer-fine); any coarse
 * pointer gets 48px (Apple HIG 44pt / Material 48dp; we ship 48).
 */
export const density = {
  comfortable: { controlHeight: 40, controlHeightTouch: 48, controlPaddingX: 16, gap: 8 },
  compact: { controlHeight: 32, controlHeightTouch: 44, controlPaddingX: 12, gap: 6 },
} as const;

export type DensityName = keyof typeof density;

/** Minimum interactive target on touch. */
export const minTouchTarget = 44;

/** Default export surface: everything a consumer needs in one object. */
export const tokens = {
  themes,
  dark: darkTheme,
  light: lightTheme,
  defaultTheme: DEFAULT_THEME,
  itemTypes,
  fontFamily,
  textScale,
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
