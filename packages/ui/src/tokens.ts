/**
 * My Secret design tokens — "Pocket Ledger" (approved 2026-11-21; source of
 * truth: design-lab/mobile/round-02/D2/spec.md + meta.js on branch
 * `design/approved`, adapted in design-lab/desktop/round-01 and
 * design-lab/extension/round-01).
 *
 * Plum is the structure: the cover band (pale plum in Light, full plum in
 * Dark), selected chips and segments, links, focus and the dock's current
 * tab. Orange is the ONE primary action per screen, always with dark ink
 * (`accent` + `accent.ink`). Each item type wears a calm tinted stamp from
 * one of seven families (`stamp`, via `typeStampFamily`). Green / amber /
 * red are status colours. Be Vietnam Pro everywhere, a system mono for
 * secrets, a 4 px spacing scale.
 *
 * This file is the ONE place to change palette, type, radii, motion:
 * tokens.css is generated from it (`npm --workspace @my-secrect/ui run tokens`,
 * enforced by tests/tokens-sync.test.ts). Platform-neutral: no React, DOM or
 * React Native imports, so web, desktop and mobile all read it.
 *
 * LEGACY KEYS. The older soft-light keys (`background`, `text`, `brand`,
 * `pastel`, `itemType`, `typePastel`, `textScale`, `typography`, …) stay
 * exported so every app compiles while Phases 2–4 restyle the screens. Where
 * a legacy role has a 1:1 Pocket Ledger role its value now follows it
 * (canvas, surface, sunken, text, hairline, control edge, orange + ink,
 * link and focus = plum, status text, item-type tile = family stamp
 * background). Roles without a counterpart keep their value, except the
 * dark fills (surface2, raised, input, muted), which move to D2's plum
 * neutrals so dark surfaces don't mix blue-grey and plum.
 *
 * CONTRAST (WCAG 2.2 AA), asserted in tests/contrast.test.ts for both
 * themes: text >= 4.5:1, control and field edges >= 3:1.
 *  - Labels on orange are dark ink (`#2A1205`), never white.
 *  - `text.faint` is for decorative glyphs and disabled states only.
 *  - Status fills (`success`, `warning`, `led`) are dots; the colours that
 *    carry text are `success.text`, `warning.text` and `danger.softText`.
 *  - Danger fills keep white labels, so `danger.DEFAULT` stays a deep red in
 *    Dark; the light-red D2 danger is the dark `danger.softText`.
 */

// ---------------------------------------------------------------------------
// Semantic themes
// ---------------------------------------------------------------------------

/** Item types (VaultItem `type` in packages/core). Each belongs to one stamp family and owns one Lucide glyph. */
export const itemTypes = [
  'login', 'passkey', 'bank_account', 'card', 'identity', 'ssh_key',
  'api_key', 'secure_note', 'document', 'media', 'collection', 'custom',
] as const;
export type ItemTypeKey = (typeof itemTypes)[number];

/** The seven stamp families: a tinted square (`bg`) with a deep glyph in Light and a light glyph in Dark (`ink`). */
export const stampFamilies = ['access', 'money', 'identity', 'note', 'file', 'dev', 'group'] as const;
export type StampFamily = (typeof stampFamilies)[number];
export interface StampColors { bg: string; ink: string }

/** Which stamp family each item type wears. */
export const typeStampFamily: Record<ItemTypeKey, StampFamily> = {
  login: 'access',
  passkey: 'access',
  card: 'money',
  bank_account: 'money',
  identity: 'identity',
  secure_note: 'note',
  custom: 'note',
  document: 'file',
  media: 'file',
  ssh_key: 'dev',
  api_key: 'dev',
  collection: 'group',
};

/** @deprecated The six soft-light pastels. Item tiles now use `stamp` (see `typeStampFamily`). */
export const pastelNames = ['sky', 'mint', 'butter', 'coral', 'lavender', 'tangerine'] as const;
/** @deprecated See `pastelNames`. */
export type PastelName = (typeof pastelNames)[number];

/**
 * @deprecated Soft-light mapping of item types to pastels. It no longer
 * drives `ThemeTokens.itemType`; use `typeStampFamily` + `ThemeTokens.stamp`.
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

function itemTypeColors(stamp: Record<StampFamily, StampColors>): Record<ItemTypeKey, string> {
  const out = {} as Record<ItemTypeKey, string>;
  for (const key of itemTypes) out[key] = stamp[typeStampFamily[key]].bg;
  return out;
}

export interface ThemeTokens {
  colorScheme: 'light' | 'dark';
  /** base = the app body (canvas); surface = cards and sheets; surface2 = sidebar, fields and chips; raised = buttons and selected segments; sunken = tracks and the secondary pill; input = text fields; muted = hover fills. */
  background: { base: string; surface: string; surface2: string; raised: string; sunken: string; input: string; muted: string };
  /** primary = ink; secondary = quiet ink; muted = tertiary ink (both >= 4.5:1); faint = decorative glyphs and disabled only. onBrand = ink on orange. onModule = ink on item-type tiles. link = plum. */
  text: { primary: string; secondary: string; muted: string; faint: string; onBrand: string; onDanger: string; onModule: string; link: string };
  /** default = the hairline (cards, dividers); strong = hover edge; subtle = quiet divider; control = the 3:1 edge of checkboxes, switch tracks and underline fields. */
  border: { default: string; strong: string; subtle: string; control: string };
  /** The orange (legacy name of `accent`): primary action only. `focus` is now plum (selection marks). */
  brand: { DEFAULT: string; hover: string; active: string; soft: string; softText: string; focus: string };
  danger: { DEFAULT: string; hover: string; soft: string; softText: string; border: string };
  success: { DEFAULT: string; text: string; soft: string };
  warning: { DEFAULT: string; text: string; soft: string };
  /** Status-dot colours (dots, meter segments and the TOTP ring only, never text). `off` is an unlit dot. */
  led: { ok: string; attention: string; danger: string; active: string; off: string };
  /** ring = the focus outline, plum (>= 3:1 on canvas and surface). */
  focus: { ring: string; width: string; offset: string };
  /** @deprecated Soft-light pastels; kept for old imports. */
  pastel: Record<PastelName, string>;
  /** One tile colour per item type: its stamp family's `bg` (legacy key; prefer `stamp`). */
  itemType: Record<ItemTypeKey, string>;
  /** Two gentle elevations: sm = resting cards and selected rows; md = dialogs, menus, toasts. */
  shadow: { sm: string; md: string };
  /** The single primary action: orange fill + dark ink. */
  accent: { DEFAULT: string; ink: string };
  /** The cover band: bg + hairline (`line`), its ink, scope chips (white/plum in Light, plum tints in Dark), the selected chip and the >= 3:1 edge of fields on the cover. */
  cover: { bg: string; ink: string; inkSecondary: string; line: string; chip: string; chipEdge: string; chipSelected: string; onChipSelected: string; fieldEdge: string };
  /** Plum structure ink: margin letters, links, focus, favourite star, TOTP bar. */
  plum: string;
  /** Selected chips, segments and checkboxes; `onSelected` is their ink. */
  selected: string;
  onSelected: string;
  /** The floating dock and its current-tab pill. */
  dock: { bg: string; selected: string };
  /** Item-type stamps by family (see `typeStampFamily`). */
  stamp: Record<StampFamily, StampColors>;
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

const lightStamp: Record<StampFamily, StampColors> = {
  access: { bg: '#f1e8f3', ink: '#6b3f78' },
  money: { bg: '#e3f0f0', ink: '#1f6068' },
  identity: { bg: '#e7f0e2', ink: '#3b6b2c' },
  note: { bg: '#f5eddc', ink: '#7a5a12' },
  file: { bg: '#e5ecf6', ink: '#2f5a8e' },
  dev: { bg: '#e9eaee', ink: '#474c5c' },
  group: { bg: '#f5e6ec', ink: '#8c3b5a' },
};

const darkStamp: Record<StampFamily, StampColors> = {
  access: { bg: '#3a2942', ink: '#ddbde8' },
  money: { bg: '#1e3a3d', ink: '#9fd6d9' },
  identity: { bg: '#253a22', ink: '#afd69c' },
  note: { bg: '#3d3220', ink: '#e6c77e' },
  file: { bg: '#22314a', ink: '#a9c4ea' },
  dev: { bg: '#2e3038', ink: '#c3c7d3' },
  group: { bg: '#3e2430', ink: '#eab0c6' },
};

/** Dark: near-black plum canvas, the full plum cover, hairlines instead of shadows, deep stamp tints. */
export const darkTheme: ThemeTokens = {
  colorScheme: 'dark',
  background: {
    base: '#141117',
    surface: '#1e1a23',
    surface2: '#1a161e',
    raised: '#28232e',
    sunken: '#28232e',
    input: '#1a161e',
    muted: '#28232e',
  },
  text: {
    primary: '#f3f0f6',
    secondary: '#b5adbe',
    muted: '#a39bad',
    faint: '#6f767d',
    onBrand: '#2a1205',
    onDanger: '#ffffff',
    onModule: '#f3f0f6',
    link: '#d7bee3',
  },
  border: { default: '#2e2935', strong: '#3d434b', subtle: '#262a2f', control: '#7c7486' },
  brand: {
    DEFAULT: '#ff8a52',
    hover: '#ff9b6b',
    active: '#ff7a3d',
    soft: 'rgba(255, 106, 43, 0.16)',
    softText: '#ffb59a',
    focus: '#d7bee3',
  },
  danger: {
    DEFAULT: '#c9363b',
    hover: '#b82f34',
    soft: 'rgba(229, 72, 77, 0.16)',
    softText: '#ff8a80',
    border: 'rgba(229, 72, 77, 0.45)',
  },
  success: { DEFAULT: '#2fa66a', text: '#6fd49a', soft: 'rgba(47, 166, 106, 0.16)' },
  warning: { DEFAULT: '#e3a12f', text: '#f2c14e', soft: 'rgba(227, 161, 47, 0.16)' },
  led: { ok: '#2fa66a', attention: '#e3a12f', danger: '#e5484d', active: '#ff8a52', off: '#3d434b' },
  focus: { ring: '#d7bee3', width: '2px', offset: '2px' },
  pastel: darkPastel,
  itemType: itemTypeColors(darkStamp),
  shadow: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.25)',
    md: '0 8px 28px rgba(0, 0, 0, 0.40)',
  },
  accent: { DEFAULT: '#ff8a52', ink: '#2a1205' },
  cover: {
    bg: '#2a1b2f',
    ink: '#ffffff',
    inkSecondary: '#d2c2da',
    line: '#2a1b2f',
    chip: '#3d2b44',
    chipEdge: '#3d2b44',
    chipSelected: '#eadcf0',
    onChipSelected: '#2a1b2f',
    fieldEdge: '#9a88a4',
  },
  plum: '#d7bee3',
  selected: '#eadcf0',
  onSelected: '#2a1b2f',
  dock: { bg: '#26212c', selected: '#3a2942' },
  stamp: darkStamp,
};

/** Light (default): white paper under a pale plum cover with plum ink. */
export const lightTheme: ThemeTokens = {
  colorScheme: 'light',
  background: {
    base: '#ffffff',
    surface: '#ffffff',
    surface2: '#faf9f7',
    raised: '#ffffff',
    sunken: '#f4f1f5',
    input: '#faf9f7',
    muted: '#f1eee9',
  },
  text: {
    primary: '#1e1923',
    secondary: '#5b5463',
    muted: '#6b6474',
    faint: '#9aa0a6',
    onBrand: '#2a1205',
    onDanger: '#ffffff',
    onModule: '#1e1923',
    link: '#6a4479',
  },
  border: { default: '#e8e3ea', strong: '#d9d4cc', subtle: '#f1eeea', control: '#8a8394' },
  brand: {
    DEFAULT: '#ff7a3d',
    hover: '#ff8a52',
    active: '#f26b2c',
    soft: '#fff0e8',
    softText: '#1e1923',
    focus: '#6a4479',
  },
  danger: {
    DEFAULT: '#b3261e',
    hover: '#9c1f18',
    soft: 'rgba(229, 72, 77, 0.10)',
    softText: '#b3261e',
    border: 'rgba(201, 54, 59, 0.40)',
  },
  success: { DEFAULT: '#2fa66a', text: '#1e7044', soft: 'rgba(47, 166, 106, 0.12)' },
  warning: { DEFAULT: '#e3a12f', text: '#8a5300', soft: 'rgba(227, 161, 47, 0.16)' },
  led: { ok: '#2fa66a', attention: '#e3a12f', danger: '#e5484d', active: '#ff7a3d', off: '#d9d4cc' },
  focus: { ring: '#6a4479', width: '2px', offset: '2px' },
  pastel: lightPastel,
  itemType: itemTypeColors(lightStamp),
  shadow: {
    sm: '0 1px 2px rgba(20, 23, 28, 0.04), 0 2px 8px rgba(20, 23, 28, 0.04)',
    md: '0 2px 6px rgba(20, 23, 28, 0.05), 0 12px 32px rgba(20, 23, 28, 0.08)',
  },
  accent: { DEFAULT: '#ff7a3d', ink: '#2a1205' },
  cover: {
    bg: '#f4eef6',
    ink: '#2a1c33',
    inkSecondary: '#5e4d68',
    line: '#e2d7e6',
    chip: '#ffffff',
    chipEdge: '#d6c8db',
    chipSelected: '#33233d',
    onChipSelected: '#ffffff',
    fieldEdge: '#8a7c94',
  },
  plum: '#6a4479',
  selected: '#33233d',
  onSelected: '#ffffff',
  dock: { bg: '#ffffff', selected: '#f1e8f3' },
  stamp: lightStamp,
};

export const themes = { light: lightTheme, dark: darkTheme } as const;
export type ThemeName = keyof typeof themes;

/** The finish a new user sees before choosing one. */
export const DEFAULT_THEME: ThemeName = 'light';

// ---------------------------------------------------------------------------
// Typography, spacing, radii, motion, breakpoints, density
// ---------------------------------------------------------------------------

/**
 * `sans` = Be Vietnam Pro (400/500/600/700, latin + latin-ext + vietnamese)
 * for every interface string, with the system stack as fallback. Web,
 * desktop and extension load it from `@my-secrect/ui/fonts.css`; mobile
 * bundles the TTFs (Phase 2). `mono` = secret values, keys and codes only
 * (data, not costume): the platform's monospace.
 */
export const fontFamily = {
  sans: "'Be Vietnam Pro', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/**
 * Pocket Ledger type roles: nine sans roles + three mono roles, line-heights
 * on the 4 px grid, nothing below 12 px. Hierarchy comes from these roles and
 * colour only. CSS: --ms-type-<role>-size / -leading / -weight.
 */
export const typeRoles = {
  /** Cover and page titles. */
  display: { fontSize: 30, lineHeight: 36, fontWeight: 700, font: 'sans' },
  /** Sheet, pane and empty-state titles. */
  title: { fontSize: 22, lineHeight: 28, fontWeight: 700, font: 'sans' },
  /** Row titles, buttons, nav title, section headings, margin letters. */
  strong: { fontSize: 16, lineHeight: 24, fontWeight: 600, font: 'sans' },
  /** Field and detail values, settings rows. */
  value: { fontSize: 16, lineHeight: 24, fontWeight: 500, font: 'sans' },
  /** Paragraphs. */
  body: { fontSize: 16, lineHeight: 24, fontWeight: 400, font: 'sans' },
  /** Chips, segments, sort, toast, dock tabs. */
  control: { fontSize: 15, lineHeight: 20, fontWeight: 600, font: 'sans' },
  /** Subtitles, helper, errors, meta. */
  caption: { fontSize: 14, lineHeight: 20, fontWeight: 500, font: 'sans' },
  /** Field and ledger labels, avatar initials. */
  label: { fontSize: 13, lineHeight: 16, fontWeight: 600, font: 'sans' },
  /** Tab labels, key index, badges, counts. */
  micro: { fontSize: 12, lineHeight: 16, fontWeight: 600, font: 'sans' },
  /** Revealed secrets. */
  monoSecret: { fontSize: 16, lineHeight: 24, fontWeight: 500, font: 'mono' },
  /** Recovery-key groups, card face, generator. */
  monoKey: { fontSize: 18, lineHeight: 24, fontWeight: 600, font: 'mono' },
  /** TOTP code. */
  monoCode: { fontSize: 24, lineHeight: 32, fontWeight: 600, font: 'mono' },
} as const;

export type TypeRole = keyof typeof typeRoles;

/**
 * @deprecated Soft-light five-step scale ([font-size, line-height] px, read
 * by components.css as --ms-text-<step> / --ms-leading-<step>). Kept until
 * the screens move to `typeRoles`.
 */
export const textScale = {
  legend: [12, 16],
  sm: [13, 20],
  md: [15, 24],
  lg: [20, 28],
  xl: [28, 34],
} as const;

export type TextStep = keyof typeof textScale;

/** @deprecated Soft-light role presets on `textScale`; use `typeRoles`. */
export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: 600, letterSpacing: '-0.01em' },
  title: { fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: '-0.01em' },
  body: { fontSize: 15, lineHeight: 24, fontWeight: 400, letterSpacing: '0em' },
  secondary: { fontSize: 13, lineHeight: 20, fontWeight: 400, letterSpacing: '0em' },
  legend: { fontSize: 12, lineHeight: 16, fontWeight: 600, letterSpacing: '0em' },
  mono: { fontSize: 13, lineHeight: 20, fontWeight: 400, letterSpacing: '0em' },
} as const;

export type TypographyKey = keyof typeof typography;

/** 4 px scale. Pocket Ledger uses 4 · 8 · 12 · 16 · 20 · 24 · 32 (steps 1–6, 8), plus 40 · 48 for desktop page padding; 2 px only for hairlines and focus. */
export const spacing = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64,
} as const;

/**
 * Pocket Ledger (D2, touch): chip 22, button 26 (52 pt pill), dock 30,
 * sheet 20, search field 24, card strip 16, cover field and key cell 12.
 * Body fields are an underline, no box. Desktop and extension use smaller
 * pill radii for their denser controls (their specs).
 * Legacy soft-light steps: xs 6, sm 10, md 14, lg 20, xl 28; `full` = pill.
 */
export const radii = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  full: 9999,
  chip: 22,
  button: 26,
  dock: 30,
  sheet: 20,
  searchField: 24,
  cardStrip: 16,
  coverField: 12,
  keyCell: 12,
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
  stampFamilies,
  typeStampFamily,
  typePastel,
  fontFamily,
  typeRoles,
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
