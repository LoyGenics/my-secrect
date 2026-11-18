/**
 * My Secret design tokens — the soft, light direction (mockup:
 * docs/mockups/ui-soft-v1.html).
 *
 * A warm, friendly personal vault: a light warm body with white cards,
 * sentence-case text, pill buttons, generous radii, two gentle shadows and a
 * soft pastel tile behind each item type's 3D picture. Dark is a "soft dark"
 * in the same spirit (warm charcoal, hairlines instead of shadows, muted
 * pastel tiles) — not the old instrument theme. Orange is for the primary
 * action only; green / amber / red are status colours.
 * Direction contract: apps/desktop/.impeccable/surfaces/apps-desktop-src-app-tsx.md
 *
 * This file is the ONE place to change palette, type, radii, motion:
 * tokens.css is generated from it (`npm --workspace @my-secrect/ui run tokens`,
 * enforced by tests/tokens-sync.test.ts). Platform-neutral: no React, DOM or
 * React Native imports, so web, desktop and mobile all read it.
 *
 * CONTRAST (WCAG 2.2 AA; the rendered result is also checked by axe-core in
 * tests/a11y-web, both themes). Deliberate deviations from the mockup:
 *  - Labels on the orange key are ink, not white: white on #ff6a2b is 2.86:1,
 *    ink on it is 5.5:1.
 *  - `text.faint` (#9aa0a6, 2.6:1 on white) is for decorative glyphs and
 *    disabled states only; every real small text uses `text.secondary`.
 *  - The status colours that carry text (`success.text`, `warning.text`,
 *    `danger.softText`) are deeper than their fills; the fills are dots.
 *  - Focus rings use `brand.focus` (deeper orange, >= 3:1 on body and cards).
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

/** The six pastel tile colours (mockup `--sky … --tangerine`), one set per theme. */
export const pastelNames = ['sky', 'mint', 'butter', 'coral', 'lavender', 'tangerine'] as const;
export type PastelName = (typeof pastelNames)[number];

/**
 * Which pastel sits behind each item type's 3D picture. Related types share a
 * colour so the sidebar categories (logins sky, cards & banks butter/coral,
 * identity & documents lavender, developer mint, notes tangerine) match the
 * list tiles.
 */
export const typePastel: Record<ItemTypeKey, PastelName> = {
  login: 'sky',
  passkey: 'mint',
  bank_account: 'coral',
  card: 'butter',
  identity: 'lavender',
  ssh_key: 'mint',
  api_key: 'mint',
  secure_note: 'tangerine',
  document: 'lavender',
  media: 'coral',
  collection: 'butter',
  custom: 'tangerine',
};

function itemTypeColors(p: Record<PastelName, string>): Record<ItemTypeKey, string> {
  const out = {} as Record<ItemTypeKey, string>;
  for (const key of itemTypes) out[key] = p[typePastel[key]];
  return out;
}

export interface ThemeTokens {
  colorScheme: 'light' | 'dark';
  /** base = the app body; surface = cards; surface2 = sidebar, fields and chips; raised = buttons and selected segments; sunken = tracks; input = text fields; muted = hover fills. */
  background: { base: string; surface: string; surface2: string; raised: string; sunken: string; input: string; muted: string };
  /** primary = ink; secondary and muted = the quiet ink (>= 4.5:1); faint = decorative glyphs and disabled only. onModule = ink on pastel tiles. */
  text: { primary: string; secondary: string; muted: string; faint: string; onBrand: string; onDanger: string; onModule: string; link: string };
  /** default = the hairline (cards, dividers, fields at rest); strong = hover edge; subtle = quiet divider; control = the 3:1 edge of checkboxes and switch tracks. */
  border: { default: string; strong: string; subtle: string; control: string };
  /** The orange: primary action only. */
  brand: { DEFAULT: string; hover: string; active: string; soft: string; softText: string; focus: string };
  danger: { DEFAULT: string; hover: string; soft: string; softText: string; border: string };
  success: { DEFAULT: string; text: string; soft: string };
  warning: { DEFAULT: string; text: string; soft: string };
  /** Status-dot colours (dots, meter segments and the TOTP ring only, never text). `off` is an unlit dot. */
  led: { ok: string; attention: string; danger: string; active: string; off: string };
  /** ring = the focus outline (>= 3:1 on body and cards). */
  focus: { ring: string; width: string; offset: string };
  /** Pastel tile colours behind the 3D pictures and category swatches. */
  pastel: Record<PastelName, string>;
  /** One tile colour per item type (a pastel, via `typePastel`). */
  itemType: Record<ItemTypeKey, string>;
  /** Two gentle elevations: sm = resting cards and selected rows; md = dialogs, menus, toasts. */
  shadow: { sm: string; md: string };
}

const darkPastel: Record<PastelName, string> = {
  sky: '#2a3a52',
  mint: '#234239',
  butter: '#4a4126',
  coral: '#4d3032',
  lavender: '#393354',
  tangerine: '#4d3825',
};

const lightPastel: Record<PastelName, string> = {
  sky: '#e6f0ff',
  mint: '#e3f5ec',
  butter: '#fff4d8',
  coral: '#ffe7e2',
  lavender: '#efeaff',
  tangerine: '#ffeede',
};

/** The soft dark theme: warm-neutral charcoal, hairlines instead of shadows, muted pastel tiles. */
export const darkTheme: ThemeTokens = {
  colorScheme: 'dark',
  background: {
    base: '#17191c',
    surface: '#212429',
    surface2: '#1c1f23',
    raised: '#2a2e34',
    sunken: '#131518',
    input: '#1c1f23',
    muted: '#2a2e34',
  },
  text: {
    primary: '#f1f2f3',
    secondary: '#c3c8ce',
    muted: '#a0a7ae',
    faint: '#6f767d',
    onBrand: '#1e2227',
    onDanger: '#ffffff',
    onModule: '#f1f2f3',
    link: '#ff9a70',
  },
  border: { default: '#2f343b', strong: '#3d434b', subtle: '#262a2f', control: '#7b828a' },
  brand: {
    DEFAULT: '#ff7a45',
    hover: '#ff8d5f',
    active: '#f56a33',
    soft: 'rgba(255, 106, 43, 0.16)',
    softText: '#ffb59a',
    focus: '#ff7a45',
  },
  danger: {
    DEFAULT: '#c9363b',
    hover: '#b82f34',
    soft: 'rgba(229, 72, 77, 0.16)',
    softText: '#ff8a8d',
    border: 'rgba(229, 72, 77, 0.45)',
  },
  success: { DEFAULT: '#2fa66a', text: '#5ed18e', soft: 'rgba(47, 166, 106, 0.16)' },
  warning: { DEFAULT: '#e3a12f', text: '#f2b84f', soft: 'rgba(227, 161, 47, 0.16)' },
  led: { ok: '#2fa66a', attention: '#e3a12f', danger: '#e5484d', active: '#ff7a45', off: '#3d434b' },
  focus: { ring: '#ff7a45', width: '2px', offset: '2px' },
  pastel: darkPastel,
  itemType: itemTypeColors(darkPastel),
  shadow: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.25)',
    md: '0 8px 28px rgba(0, 0, 0, 0.40)',
  },
};

/** The light theme (default), straight from the approved mockup. */
export const lightTheme: ThemeTokens = {
  colorScheme: 'light',
  background: {
    base: '#f6f4f1',
    surface: '#ffffff',
    surface2: '#faf9f7',
    raised: '#ffffff',
    sunken: '#efece8',
    input: '#faf9f7',
    muted: '#f1eee9',
  },
  text: {
    primary: '#1e2227',
    secondary: '#5f656c',
    muted: '#5f656c',
    faint: '#9aa0a6',
    onBrand: '#1e2227',
    onDanger: '#ffffff',
    onModule: '#1e2227',
    link: '#b83c0a',
  },
  border: { default: '#ebe8e3', strong: '#d9d4cc', subtle: '#f1eeea', control: '#8a857d' },
  brand: {
    DEFAULT: '#ff6a2b',
    hover: '#ff7d47',
    active: '#f05a1a',
    soft: '#fff0e8',
    softText: '#1e2227',
    focus: '#d4460e',
  },
  danger: {
    DEFAULT: '#c9363b',
    hover: '#b82f34',
    soft: 'rgba(229, 72, 77, 0.10)',
    softText: '#b42328',
    border: 'rgba(201, 54, 59, 0.40)',
  },
  success: { DEFAULT: '#2fa66a', text: '#1a7a47', soft: 'rgba(47, 166, 106, 0.12)' },
  warning: { DEFAULT: '#e3a12f', text: '#8a5a00', soft: 'rgba(227, 161, 47, 0.16)' },
  led: { ok: '#2fa66a', attention: '#e3a12f', danger: '#e5484d', active: '#ff6a2b', off: '#d9d4cc' },
  focus: { ring: '#d4460e', width: '2px', offset: '2px' },
  pastel: lightPastel,
  itemType: itemTypeColors(lightPastel),
  shadow: {
    sm: '0 1px 2px rgba(20, 23, 28, 0.04), 0 2px 8px rgba(20, 23, 28, 0.04)',
    md: '0 2px 6px rgba(20, 23, 28, 0.05), 0 12px 32px rgba(20, 23, 28, 0.08)',
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
 * `sans` = the platform's rounded system face for every interface string
 * (SF Pro Rounded on Apple, system-ui elsewhere; no web font to load).
 * `mono` = secret values, keys and hashes only (data, not costume). Mobile
 * keeps the platform font.
 */
export const fontFamily = {
  sans: "ui-rounded, 'SF Pro Rounded', 'SF Pro Text', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
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

/** xs: small marks; sm: icon buttons, nav rows; md: fields, rows, banners; lg: cards; xl: dialogs, the window and the lock card. Buttons are pills (`full`). */
export const radii = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  full: 9999,
} as const;

/** Shadows of the default (light) theme; per-theme values live in `ThemeTokens.shadow`. */
export const shadows = lightTheme.shadow;

export const borders = { width: { hairline: 1, default: 1, strong: 2 } } as const;

/**
 * Soft motion: 0.2s with one gentle ease-out curve, no bounce. `turn` is the
 * unlock moment (the lock card fades up and away). Under reduced motion
 * components swap movement for an opacity crossfade (or nothing) — see
 * components.css.
 */
export const motion = {
  duration: { fast: 120, base: 200, slow: 240, turn: 320 },
  easing: {
    standard: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    out: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
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
  typePastel,
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
