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

export { stampFamilies, type StampColors, type StampFamily } from '../../../../packages/ui/src/tokens';

export function mobileColorRoles(theme: ThemeTokens) {
  return {
    canvas: theme.background.base,
    surface: theme.background.surface,
    surfaceMuted: theme.background.sunken,
    sunken: theme.background.sunken,
    inputSurface: theme.background.surface,
    text: theme.text.primary,
    secondaryText: theme.text.secondary,
    mutedText: theme.text.muted,
    border: theme.border.default,
    controlBorder: theme.border.control,
    // Orange is the one primary action per screen, always with dark ink.
    primaryFill: theme.accent.DEFAULT,
    primaryPressed: theme.brand.active,
    onPrimary: theme.accent.ink,
    // Plum is the structure: links, focus, selection marks, favourite star.
    primaryTextLink: theme.text.link,
    plum: theme.plum,
    star: theme.plum,
    selection: theme.dock.selected,
    selected: theme.selected,
    onSelected: theme.onSelected,
    focus: theme.focus.ring,
    cover: theme.cover.bg,
    onCover: theme.cover.ink,
    onCoverSecondary: theme.cover.inkSecondary,
    coverLine: theme.cover.line,
    coverChip: theme.cover.chip,
    coverChipEdge: theme.cover.chipEdge,
    coverChipSelected: theme.cover.chipSelected,
    onCoverChipSelected: theme.cover.onChipSelected,
    coverFieldEdge: theme.cover.fieldEdge,
    dock: theme.dock.bg,
    dockSelected: theme.dock.selected,
    danger: theme.danger.DEFAULT,
    dangerPressed: theme.danger.hover,
    onDanger: theme.text.onDanger,
    dangerText: theme.danger.softText,
    dangerSoft: theme.danger.soft,
    success: theme.success.DEFAULT,
    successText: theme.success.text,
    successSoft: theme.success.soft,
    warning: theme.warning.DEFAULT,
    warningText: theme.warning.text,
    warningSoft: theme.warning.soft,
    scrim: 'rgba(20, 12, 24, 0.48)',
    stamp: theme.stamp,
  };
}

export const mobileLightRoles = mobileColorRoles(lightTheme);
export const mobileDarkRoles = mobileColorRoles(darkTheme);
