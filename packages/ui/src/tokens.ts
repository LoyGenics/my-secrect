/**
 * My Secret design tokens — "Precision Instrument".
 *
 * The vault is a precisely made personal device: two finishes of one
 * object (light anodized aluminium, dark graphite), colour used ONLY as
 * signal (one orange key for the primary action and focus; green / amber /
 * red LEDs), flat machined plates with a 1px hairline and a 1px inner top
 * highlight, recessed wells for inputs, molded keys with printed legends.
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
 *   ink #1B1C1E on plate #F2F1EE   15.10:1    ink #ECEBE7 on plate #1F2022  13.67:1
 *   ink on body #E6E4DF            13.42:1    ink on body #161718           15.05:1
 *   muted #55575B on well #D9D7D1   5.03:1    muted #9A9C9F on well #111213  6.81:1
 *   legend ink on orange key        5.50:1    legend ink on orange key       5.50:1
 *   white on danger key #C42F36     5.52:1    white on danger key            5.52:1
 *   danger text #B42328 on plate    5.79:1    danger text #FF8A8D on plate   7.20:1
 *   warning text #8A5A00 on plate   5.25:1    warning text #F2A93B on plate  8.16:1
 *   success text #1A6E3E on plate   >=5.5:1   success text #5ED18E on plate  8.53:1
 *
 * White on orange is 3.10:1, so key legends on orange are ink, never white.
 * Orange vs the aluminium body is 2.44:1 — below the 3:1 non-text bar — so
 * the light finish draws focus as a two-band printed mark: an ink band
 * (`focus.outline`, 13:1) inside the orange ring. Graphite needs no band
 * (orange vs body 5.79:1). LED colours are never text; status text uses the
 * `*.text` tokens with an LED dot beside it.
 */

// ---------------------------------------------------------------------------
// Semantic themes
// ---------------------------------------------------------------------------

/** Item types (VaultItem `type` in packages/core). Each owns one module silhouette and one muted code colour. */
export const itemTypes = [
  'login', 'passkey', 'bank_account', 'card', 'identity', 'ssh_key',
  'api_key', 'secure_note', 'document', 'media', 'collection', 'custom',
] as const;
export type ItemTypeKey = (typeof itemTypes)[number];

export interface ThemeTokens {
  colorScheme: 'light' | 'dark';
  /** base = the device chassis; surface = machined plates; sunken/input = recessed wells; muted = tracks and chips. */
  background: { base: string; surface: string; raised: string; sunken: string; input: string; muted: string };
  text: { primary: string; secondary: string; muted: string; faint: string; onBrand: string; onDanger: string; link: string };
  /** default = the 1px hairline; control = the only border meeting 3:1 (wells, switches). */
  border: { default: string; strong: string; subtle: string; control: string };
  /** The orange key: primary action and focus only. */
  brand: { DEFAULT: string; hover: string; active: string; soft: string; softText: string; focus: string };
  danger: { DEFAULT: string; hover: string; soft: string; softText: string; border: string };
  success: { DEFAULT: string; text: string; soft: string };
  warning: { DEFAULT: string; text: string; soft: string };
  /** LED colours (dots and segments only, never text). `off` is an unlit segment. */
  led: { ok: string; attention: string; danger: string; active: string; off: string };
  /** ring = orange; outline = the contrast band drawn with it (transparent when not needed). */
  focus: { ring: string; outline: string; width: string; offset: string };
  /** Machining: plate top highlight, key lower edges, well inner shadow. */
  edge: { highlight: string; key: string; keyBrand: string; keyDanger: string; well: string };
  /** One muted code colour per item type (module fills). Icon ink on every fill is >= 7:1. */
  itemType: Record<ItemTypeKey, string>;
  shadow: { sm: string; md: string; lg: string; overlay: string };
}

/** Graphite — the dark finish. Default. */
export const darkTheme: ThemeTokens = {
  colorScheme: 'dark',
  background: {
    base: '#161718',
    surface: '#1F2022',
    raised: '#26282A',
    sunken: '#111213',
    input: '#111213',
    muted: '#2A2C2F',
  },
  text: {
    primary: '#ECEBE7',
    secondary: '#C9C8C4',
    muted: '#9A9C9F',
    faint: '#6E7073',
    onBrand: '#1B1C1E',
    onDanger: '#FFFFFF',
    link: '#ECEBE7',
  },
  border: { default: '#2E3033', strong: '#3A3C40', subtle: '#26282A', control: '#6E7073' },
  brand: {
    DEFAULT: '#FF5B1F',
    hover: '#FF7A45',
    active: '#E64A12',
    soft: 'rgba(255, 91, 31, 0.16)',
    softText: '#FFB59A',
    focus: '#FF5B1F',
  },
  danger: {
    DEFAULT: '#C42F36',
    hover: '#B92C33',
    soft: 'rgba(229, 72, 77, 0.16)',
    softText: '#FF8A8D',
    border: 'rgba(229, 72, 77, 0.50)',
  },
  success: { DEFAULT: '#35B46A', text: '#5ED18E', soft: 'rgba(53, 180, 106, 0.14)' },
  warning: { DEFAULT: '#F2A93B', text: '#F2A93B', soft: 'rgba(242, 169, 59, 0.14)' },
  led: { ok: '#35B46A', attention: '#F2A93B', danger: '#E5484D', active: '#FF5B1F', off: '#2E3033' },
  focus: { ring: '#FF5B1F', outline: 'transparent', width: '2px', offset: '2px' },
  edge: {
    highlight: 'rgba(255, 255, 255, 0.05)',
    key: '#0B0C0D',
    keyBrand: '#B23A0E',
    keyDanger: '#7E1B20',
    well: 'rgba(0, 0, 0, 0.45)',
  },
  itemType: {
    login: '#2F3A4A',
    passkey: '#29403C',
    bank_account: '#3A4030',
    card: '#40334A',
    identity: '#4A3F30',
    ssh_key: '#33383F',
    api_key: '#304230',
    secure_note: '#4A4226',
    document: '#4A3530',
    media: '#3E3249',
    collection: '#2E4237',
    custom: '#3A3834',
  },
  shadow: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.40)',
    md: '0 4px 12px rgba(0, 0, 0, 0.45)',
    lg: '0 12px 28px rgba(0, 0, 0, 0.50)',
    overlay: '0 18px 48px rgba(0, 0, 0, 0.60)',
  },
};

/** Anodized aluminium — the light finish. */
export const lightTheme: ThemeTokens = {
  colorScheme: 'light',
  background: {
    base: '#E6E4DF',
    surface: '#F2F1EE',
    raised: '#F7F6F3',
    sunken: '#D9D7D1',
    input: '#D9D7D1',
    muted: '#DDDBD5',
  },
  text: {
    primary: '#1B1C1E',
    secondary: '#3A3B3E',
    muted: '#55575B',
    faint: '#8A8C8F',
    onBrand: '#1B1C1E',
    onDanger: '#FFFFFF',
    link: '#1B1C1E',
  },
  border: { default: '#C4C2BC', strong: '#ABA9A3', subtle: '#D4D2CC', control: '#7C7A74' },
  brand: {
    DEFAULT: '#FF5B1F',
    hover: '#FF7A45',
    active: '#E64A12',
    soft: 'rgba(255, 91, 31, 0.14)',
    softText: '#1B1C1E',
    focus: '#FF5B1F',
  },
  danger: {
    DEFAULT: '#C42F36',
    hover: '#B92C33',
    soft: 'rgba(229, 72, 77, 0.12)',
    softText: '#B42328',
    border: 'rgba(196, 47, 54, 0.55)',
  },
  success: { DEFAULT: '#35B46A', text: '#1A6E3E', soft: 'rgba(53, 180, 106, 0.14)' },
  warning: { DEFAULT: '#F2A93B', text: '#8A5A00', soft: 'rgba(242, 169, 59, 0.18)' },
  led: { ok: '#35B46A', attention: '#F2A93B', danger: '#E5484D', active: '#FF5B1F', off: '#C4C2BC' },
  focus: { ring: '#FF5B1F', outline: '#1B1C1E', width: '2px', offset: '2px' },
  edge: {
    highlight: 'rgba(255, 255, 255, 0.75)',
    key: '#A9A6A0',
    keyBrand: '#B23A0E',
    keyDanger: '#7E1B20',
    well: 'rgba(0, 0, 0, 0.14)',
  },
  itemType: {
    login: '#C9D3E0',
    passkey: '#C5DDD8',
    bank_account: '#D6DCC4',
    card: '#DCCFDD',
    identity: '#E3D6C2',
    ssh_key: '#CBD0D6',
    api_key: '#CFE0C9',
    secure_note: '#E8DDB5',
    document: '#E2CDC3',
    media: '#D9CCE3',
    collection: '#C8D9CF',
    custom: '#D6D3CC',
  },
  shadow: {
    sm: '0 1px 2px rgba(60, 55, 45, 0.12)',
    md: '0 4px 12px rgba(60, 55, 45, 0.14)',
    lg: '0 12px 28px rgba(60, 55, 45, 0.18)',
    overlay: '0 18px 48px rgba(60, 55, 45, 0.24)',
  },
};

export const themes = { light: lightTheme, dark: darkTheme } as const;
export type ThemeName = keyof typeof themes;

// ---------------------------------------------------------------------------
// Typography, spacing, radii, motion, breakpoints, density
// ---------------------------------------------------------------------------

/**
 * `sans` = native system UI for body and fields. `legend` = the one
 * self-hosted semi-condensed industrial grotesk (Barlow Semi Condensed,
 * OFL, @fontsource; Vietnamese subset included) for printed legends and
 * headings. `mono` = secret values, keys and hashes only (data, not costume).
 */
export const fontFamily = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  legend: "'Barlow Semi Condensed', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/**
 * The strict five-step scale: [font-size, line-height] px. Every component
 * reads --ms-text-<step> / --ms-leading-<step>; there is no sixth size.
 * legend = printed key/LCD legends (uppercase, tracked); sm = secondary
 * lines; md = body, fields, list titles; lg = view and detail titles;
 * xl = the device-face wordmark and the Watchtower readout.
 */
export const textScale = {
  legend: [11, 14],
  sm: [13, 18],
  md: [15, 22],
  lg: [20, 26],
  xl: [28, 32],
} as const;

export type TextStep = keyof typeof textScale;

/** Tracking for printed legends (uppercase). */
export const legendTracking = '0.08em';

/** Role presets on the five-step scale (mobile reads these directly). */
export const typography = {
  display: { fontSize: 28, lineHeight: 32, fontWeight: 600, letterSpacing: '0em' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: 600, letterSpacing: '0em' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: 400, letterSpacing: '0em' },
  secondary: { fontSize: 13, lineHeight: 18, fontWeight: 400, letterSpacing: '0em' },
  legend: { fontSize: 11, lineHeight: 14, fontWeight: 600, letterSpacing: legendTracking, textTransform: 'uppercase' as const },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: 400, letterSpacing: '0em' },
} as const;

export type TypographyKey = keyof typeof typography;

/** 4px base scale. */
export const spacing = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64,
} as const;

/** xs: LED segments, chips; sm: keys and wells; md: plates; lg: sheets and the device face. */
export const radii = {
  xs: 3,
  sm: 6,
  md: 12,
  lg: 16,
  full: 9999,
} as const;

/** Dark-finish shadows (kept for existing imports); per-theme values live in `ThemeTokens.shadow`. */
export const shadows = darkTheme.shadow;

export const borders = { width: { hairline: 1, default: 1, strong: 2 } } as const;

/**
 * Mechanical motion: short ease-out detents, no bounce. `turn` is the
 * unlock "key turn". Under reduced motion components swap movement for an
 * opacity crossfade (or nothing) — see components.css.
 */
export const motion = {
  duration: { fast: 120, base: 160, slow: 180, turn: 280 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  reduceMotionQuery: '(prefers-reduced-motion: reduce)',
} as const;

/** Layout breakpoints: phone < 768 <= tablet < 1024 <= desktop. */
export const breakpoints = { sm: 480, md: 768, lg: 1024, xl: 1280 } as const;

/**
 * Density. Desktop keys and wells are 36px (pointer-fine); any coarse
 * pointer gets 48px (Apple HIG 44pt / Material 48dp; we ship 48).
 */
export const density = {
  comfortable: { controlHeight: 36, controlHeightTouch: 48, controlPaddingX: 14, gap: 8 },
  compact: { controlHeight: 28, controlHeightTouch: 44, controlPaddingX: 10, gap: 6 },
} as const;

export type DensityName = keyof typeof density;

/** Minimum interactive target on touch. */
export const minTouchTarget = 44;

/** Default export surface: everything a consumer needs in one object. */
export const tokens = {
  themes,
  dark: darkTheme,
  light: lightTheme,
  itemTypes,
  fontFamily,
  textScale,
  legendTracking,
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
