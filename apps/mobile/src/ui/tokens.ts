import { darkTheme, lightTheme, type ThemeTokens } from '../../../../packages/ui/src/tokens';

/** Pocket Ledger spacing: 4 · 8 · 12 · 16 · 20 · 24 · 32 (40/48 only for fixed slots). */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const;
export const radius = {
  checkbox: 4, glyph: 8, stamp: 8, coverField: 12, keyCell: 12, field: 12, surface: 16, cardStrip: 16, sheet: 20,
  chip: 22, search: 24, button: 26, dock: 30, full: 999,
} as const;
export const size = {
  action: 52,
  touch: 44,
  androidTouch: 48,
  field: 48,
  chip: 44,
  settingsRow: 48,
  itemRow: 56,
  fileRow: 56,
  detailRow: 56,
  chooserRow: 60,
  detailLabel: 96,
  icon: 20,
  inlineIcon: 16,
  tabIcon: 24,
  leadingSlot: 24,
  stamp: 32,
  marginLetter: 40,
  avatar: 40,
  dock: 60,
  dockSearch: 60,
  formWidth: 720,
  listWidth: 840,
  navigationRailBreakpoint: 768,
  navigationRailWidth: 224,
  visibleSheetWidth: 600,
  emptyArt: 112,
  brandMark: 36,
} as const;

/** Be Vietnam Pro faces, registered by name in ui/fonts.ts before the first render. */
export const fontFamily = {
  regular: 'BeVietnamPro-Regular',
  medium: 'BeVietnamPro-Medium',
  semibold: 'BeVietnamPro-SemiBold',
  bold: 'BeVietnamPro-Bold',
} as const;

const strong = { fontFamily: fontFamily.semibold, fontSize: 16, lineHeight: 24 } as const;
const caption = { fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 20 } as const;

/**
 * Nine sans roles + three mono roles; line-heights sit on the 4 pt grid.
 * Each sans role names its face, so no role sets fontWeight (custom faces
 * would be synthesised). Mono roles get the platform monospace in theme.ts.
 */
export const textStyle = {
  display: { fontFamily: fontFamily.bold, fontSize: 30, lineHeight: 36 },
  title: { fontFamily: fontFamily.bold, fontSize: 22, lineHeight: 28 },
  strong,
  value: { fontFamily: fontFamily.medium, fontSize: 16, lineHeight: 24 },
  body: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 24 },
  control: { fontFamily: fontFamily.semibold, fontSize: 15, lineHeight: 20 },
  caption,
  label: { fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16 },
  micro: { fontFamily: fontFamily.semibold, fontSize: 12, lineHeight: 16 },
  secret: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  key: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  code: { fontSize: 24, lineHeight: 32, fontWeight: '600' },
  /** Legacy names kept while screens migrate: nav/item = strong, helper = caption. */
  nav: strong,
  item: strong,
  helper: caption,
} as const;

export function getPageGutter(width: number): number {
  return width < 600 ? space[4] : space[6];
}

export type AppButtonSize = 'default' | 'compact' | 'icon';

export function getButtonState(buttonSize: AppButtonSize, textOnly: boolean, android: boolean, disabled: boolean, loading: boolean) {
  const iconOnly = buttonSize === 'icon';
  const compact = buttonSize !== 'default' || textOnly;
  const touchSize = android ? size.androidTouch : size.touch;
  return {
    iconOnly, compact, minHeight: compact ? touchSize : size.action,
    width: iconOnly ? touchSize : undefined,
    busy: loading,
    inactive: disabled || loading,
  };
}

export const stampFamilies = ['access', 'money', 'identity', 'note', 'file', 'dev', 'group'] as const;
export type StampFamily = (typeof stampFamilies)[number];
export interface StampColors { bg: string; ink: string }

/** Pocket Ledger roles (D2 R2 meta.js) that the shared tokens do not carry yet. */
const pocketLedger = {
  light: {
    accent: { DEFAULT: '#ff7a3d', ink: '#2a1205', active: '#f26b2c' },
    cover: {
      bg: '#f4eef6', ink: '#2a1c33', inkSecondary: '#5e4d68', line: '#e2d7e6', chip: '#ffffff', chipEdge: '#d6c8db',
      chipSelected: '#33233d', onChipSelected: '#ffffff', fieldEdge: '#8a7c94',
    },
    plum: '#6a4479',
    selected: '#33233d',
    onSelected: '#ffffff',
    dock: { bg: '#ffffff', selected: '#f1e8f3' },
    canvas: '#ffffff', surface: '#ffffff', sunken: '#f4f1f5',
    text: '#1e1923', textSecondary: '#5b5463', textTertiary: '#6b6474',
    border: '#e8e3ea', control: '#8a8394',
    danger: '#b3261e', dangerPressed: '#9c1f18', dangerText: '#b3261e', successText: '#1e7044', warningText: '#8a5300',
    stamp: {
      access: { bg: '#f1e8f3', ink: '#6b3f78' }, money: { bg: '#e3f0f0', ink: '#1f6068' }, identity: { bg: '#e7f0e2', ink: '#3b6b2c' },
      note: { bg: '#f5eddc', ink: '#7a5a12' }, file: { bg: '#e5ecf6', ink: '#2f5a8e' }, dev: { bg: '#e9eaee', ink: '#474c5c' },
      group: { bg: '#f5e6ec', ink: '#8c3b5a' },
    } satisfies Record<StampFamily, StampColors>,
  },
  dark: {
    accent: { DEFAULT: '#ff8a52', ink: '#2a1205', active: '#ff7a3d' },
    cover: {
      bg: '#2a1b2f', ink: '#ffffff', inkSecondary: '#d2c2da', line: '#2a1b2f', chip: '#3d2b44', chipEdge: '#3d2b44',
      chipSelected: '#eadcf0', onChipSelected: '#2a1b2f', fieldEdge: '#9a88a4',
    },
    plum: '#d7bee3',
    selected: '#eadcf0',
    onSelected: '#2a1b2f',
    dock: { bg: '#26212c', selected: '#3a2942' },
    canvas: '#141117', surface: '#1e1a23', sunken: '#28232e',
    text: '#f3f0f6', textSecondary: '#b5adbe', textTertiary: '#a39bad',
    border: '#2e2935', control: '#7c7486',
    danger: '#c9363b', dangerPressed: '#b82f34', dangerText: '#ff8a80', successText: '#6fd49a', warningText: '#f2c14e',
    stamp: {
      access: { bg: '#3a2942', ink: '#ddbde8' }, money: { bg: '#1e3a3d', ink: '#9fd6d9' }, identity: { bg: '#253a22', ink: '#afd69c' },
      note: { bg: '#3d3220', ink: '#e6c77e' }, file: { bg: '#22314a', ink: '#a9c4ea' }, dev: { bg: '#2e3038', ink: '#c3c7d3' },
      group: { bg: '#3e2430', ink: '#eab0c6' },
    } satisfies Record<StampFamily, StampColors>,
  },
} as const;

export function mobileColorRoles(theme: ThemeTokens) {
  const pl = pocketLedger[theme.colorScheme];
  return {
    canvas: pl.canvas,
    surface: pl.surface,
    surfaceMuted: pl.sunken,
    sunken: pl.sunken,
    inputSurface: pl.surface,
    text: pl.text,
    secondaryText: pl.textSecondary,
    mutedText: pl.textTertiary,
    border: pl.border,
    controlBorder: pl.control,
    // Orange is the one primary action per screen, always with dark ink.
    primaryFill: pl.accent.DEFAULT,
    primaryPressed: pl.accent.active,
    onPrimary: pl.accent.ink,
    // Plum is the structure: links, focus, selection marks, favourite star.
    primaryTextLink: pl.plum,
    plum: pl.plum,
    star: pl.plum,
    selection: pl.dock.selected,
    selected: pl.selected,
    onSelected: pl.onSelected,
    focus: pl.plum,
    cover: pl.cover.bg,
    onCover: pl.cover.ink,
    onCoverSecondary: pl.cover.inkSecondary,
    coverLine: pl.cover.line,
    coverChip: pl.cover.chip,
    coverChipEdge: pl.cover.chipEdge,
    coverChipSelected: pl.cover.chipSelected,
    onCoverChipSelected: pl.cover.onChipSelected,
    coverFieldEdge: pl.cover.fieldEdge,
    dock: pl.dock.bg,
    dockSelected: pl.dock.selected,
    danger: pl.danger,
    dangerPressed: pl.dangerPressed,
    onDanger: theme.text.onDanger,
    dangerText: pl.dangerText,
    dangerSoft: theme.danger.soft,
    success: theme.success.DEFAULT,
    successText: pl.successText,
    successSoft: theme.success.soft,
    warning: theme.warning.DEFAULT,
    warningText: pl.warningText,
    warningSoft: theme.warning.soft,
    scrim: 'rgba(20, 12, 24, 0.48)',
    stamp: pl.stamp as Record<StampFamily, StampColors>,
  };
}

export const mobileLightRoles = mobileColorRoles(lightTheme);
export const mobileDarkRoles = mobileColorRoles(darkTheme);
