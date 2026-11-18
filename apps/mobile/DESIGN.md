---
name: My Secret Mobile
description: A personal vault with platform-native navigation, warm grouped surfaces and composable search.
colors:
  primary-fill: "#D23F0C"
  on-primary: "#FFFFFF"
  link-light: "#B83C0A"
  link-dark: "#FF9A70"
  canvas-light: "#F6F4F1"
  canvas-dark: "#17191C"
  surface-light: "#FFFFFF"
  surface-dark: "#212429"
typography:
  display: { fontSize: "28px", lineHeight: "34px", fontWeight: 700 }
  title: { fontSize: "22px", lineHeight: "28px", fontWeight: 700 }
  navigation-title: { fontSize: "18px", lineHeight: "24px", fontWeight: 600 }
  body: { fontSize: "16px", lineHeight: "24px" }
  helper: { fontSize: "14px", lineHeight: "20px" }
  caption: { fontSize: "12px", lineHeight: "16px" }
rounded:
  glyph: "10px"
  field: "14px"
  button: "14px"
  surface: "16px"
  sheet: "24px"
spacing:
  field-label: "8px"
  button-stack: "12px"
  field-gap: "16px"
  section-gap: "24px"
  large-section-gap: "32px"
components:
  primary-action:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.button}"
    height: "52px"
  field:
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    height: "52px"
  settings-row: { height: "56px" }
  vault-row: { height: "72px" }
  file-row: { height: "76px" }
---

# My Secret mobile design system

The vault opens on its contents. Use a compact native title bar, quiet grouped rows and clear actions for finding, inspecting and copying items. Keep account sign-in separate from vault unlock. The ghost mark and warm palette establish the brand. Native stacks, tabs, keyboards, confirmations and pickers retain platform behavior.

[Mobile tokens](src/ui/tokens.ts) define layout and typography and derive colors from the [shared palette](../../packages/ui/src/tokens.ts). [The mobile theme](src/theme.ts) exposes the current roles. [AppearanceProvider](src/ui/AppearanceProvider.tsx) resolves System, Light or Dark, persists the choice with the auto-lock interval and applies the native scheme. Startup waits for preference and locale hydration before entering vault screens.

## Layout and type

- `AppPage` owns the page gutter, content cap, scrolling, keyboard avoidance and safe-area position. Use only one page wrapper. Native screens with a stack header use the navigator's top inset. First-run screens use the full safe area. Use the bottom inset for routes with fixed actions above the home indicator.
- Gutters are 16 logical units below 360, 20 from 360 to 599 and 24 at 600 and up. The forms/settings column caps at 720 and list/grid surfaces cap at 840. Page headers and sticky footers take the same inset as the content.
- Use `space` with steps 0, 4, 8, 12, 16, 20, 24, 32, 40 and 48. Field labels have an 8-unit gap to the control, fields have a 16-unit gap, related sections separate by 24 and larger sections by 32. Stacked buttons have a 12-unit gap.
- Use the platform system face and the display, title, nav, body, helper and caption roles defined above. Keep labels and validation text able to wrap. Fields and actions use minimum heights so larger fonts can grow the layout.
- Use glyph wells with radius 10, fields and actions with radius 14, groups with radius 16, sheet corners with radius 24 and pills for compact chips.

## Colors and contrast

Use `canvas`, `surface`, `surfaceMuted` and `inputSurface` consistently for structure. Text, secondary text, body links and statuses have their own foreground roles. Use orange fill with the semantic `onPrimary` for primary actions and `primaryTextLink` for link actions. Use `dangerText`, `successText` and `warningText` on surfaces. Preserve border/control distinction for low-contrast separators and clearly defined fields.

The [foundation tests](tests/ui-foundation.test.ts) check the foreground and control pairs in both schemes. These ratios describe colors in the token layer.

| Pair | Light | Dark | Minimum |
|---|---:|---:|---:|
| Text on canvas | 14.57 | 15.71 | 4.5 |
| Secondary text on surface | 5.89 | 9.25 | 4.5 |
| Placeholder on input | 5.60 | 6.80 | 4.5 |
| Link text on canvas | 5.19 | 8.48 | 4.5 |
| Text on primary action | 4.71 | 4.71 | 4.5 |
| Text on destructive action | 5.15 | 5.15 | 4.5 |
| Error text on surface | 6.54 | 6.87 | 4.5 |
| Success text on surface | 5.36 | 8.14 | 4.5 |
| Warning text on surface | 5.93 | 8.71 | 4.5 |
| Control edge against input | 3.48 | 4.25 | 3.0 |
| Focus ring against surface | 4.49 | 6.02 | 3.0 |

## Component usage

- `AppPage`, `PageSection`, `FormSection` and `FieldGroup` manage the layout. Use flush fields within `FieldGroup` and let that group supply the gaps.
- `AppButton` takes a semantic variant and optional leading icon. Icon and label center as one unit. Loading replaces the icon or uses a reserved slot beside the label. `IconButton` always takes an accessible action label and uses a minimum 44-by-44 target on iOS or 48-by-48 on Android.
- `AppTextField` supplies a persistent label, contextual helper or inline error, theme-aware keyboard appearance and trailing utilities. Revealable fields show a masked input on first render. Set `keyboardType`, capitalization and IME action to suit the data.
- `SettingsRow` reserves a 24-unit leading icon slot. It only shows a forward chevron for navigation. `Rule leading` aligns the separator to the text after a leading slot. `ToggleRow` exposes the switch as the interactive element. Radio selections use an accessible checked state and a stable trailing check slot.
- `SelectField` opens `BottomSheet` for searchable choices. Use `SegmentedControl` or a native radio screen when there are few stable choices. `BottomSheet` takes a title, close action and optional fixed footer, scrolls body content and applies bottom insets. Platform `Dialog` handles confirmations.
- `EmptyState`, `InlineError`, `Toast` and `Progress` report real screen state. Keep errors near the related action. Use an indeterminate progress indicator when the underlying operation cannot report a percentage.
- Use the shared native `Icon` vocabulary. Generic glyphs use 20, supplemental inline glyphs use 18 and tab glyphs use 24. Use the system header for Back/Close, then place right-aligned toolbar actions in consistent icon slots.

Compatibility names `Page`, `Action`, `Row`, `Empty`, `Field`, `Btn`, `SoftField` and `SoftScreen` resolve to the shared primitives while screens migrate. New screens use their named replacements. `AuthLayout` uses the same page and field rules and adapts optional illustration size to the viewport and text scale.

## Verification

Use synthetic vault contents. Check both platform appearances, small phones and tablet widths, large text, scroll and keyboard behavior, VoiceOver and TalkBack. Inspect screenshots against shared page, control and text baselines. Test System theme changes, forced overrides after app termination and the persisted auto-lock interval.
