import { darkTheme, lightTheme, type ThemeTokens } from '../../../../packages/ui/src/tokens';

export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const;
export const radius = { checkbox: 4, glyph: 10, field: 14, button: 14, surface: 16, sheet: 24, full: 999 } as const;
export const size = {
  action: 52,
  touch: 44,
  androidTouch: 48,
  field: 52,
  settingsRow: 56,
  itemRow: 72,
  fileRow: 76,
  icon: 20,
  inlineIcon: 18,
  tabIcon: 24,
  leadingSlot: 24,
  formWidth: 720,
  listWidth: 840,
  navigationRailBreakpoint: 768,
  navigationRailWidth: 224,
  visibleSheetWidth: 600,
  emptyArt: 112,
  brandMark: 36,
} as const;

export const textStyle = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  nav: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24 },
  item: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  helper: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 16 },
} as const;

export function getPageGutter(width: number): number {
  if (width < 360) return space[4];
  return width < 600 ? space[5] : space[6];
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

export function mobileColorRoles(theme: ThemeTokens) {
  return {
    canvas: theme.background.base,
    surface: theme.background.surface,
    surfaceMuted: theme.background.surface2,
    inputSurface: theme.background.input,
    text: theme.text.primary,
    secondaryText: theme.text.secondary,
    mutedText: theme.text.muted,
    border: theme.border.default,
    controlBorder: theme.border.control,
    // The filled mobile action uses white text in both modes. Shared link and
    // focus colors adapt independently to the surface under them.
    primaryFill: '#D23F0C',
    primaryPressed: '#AE3108',
    onPrimary: theme.text.onDanger,
    primaryTextLink: theme.text.link,
    selection: theme.brand.soft,
    focus: theme.focus.ring,
    danger: theme.danger.DEFAULT,
    dangerPressed: theme.danger.hover,
    dangerText: theme.danger.softText,
    dangerSoft: theme.danger.soft,
    success: theme.success.DEFAULT,
    successText: theme.success.text,
    successSoft: theme.success.soft,
    warning: theme.warning.DEFAULT,
    warningText: theme.warning.text,
    warningSoft: theme.warning.soft,
    scrim: 'rgba(0, 0, 0, 0.42)',
  };
}

export const mobileLightRoles = mobileColorRoles(lightTheme);
export const mobileDarkRoles = mobileColorRoles(darkTheme);
