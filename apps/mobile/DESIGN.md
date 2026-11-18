---
name: My Secret Mobile
description: A personal vault with platform-native navigation, quiet grouped surfaces, and a single place to search.
colors:
  primary-fill: "#D23F0C"
  white: "#FFFFFF"
  link-light: "#b83c0a"
  link-dark: "#ff9a70"
  selection-light: "#fff0e8"
  selection-dark: "rgba(255, 106, 43, 0.16)"
  canvas-light: "#f6f4f1"
  canvas-dark: "#17191c"
  surface-dark: "#212429"
  inset-light: "#faf9f7"
  inset-dark: "#1c1f23"
  ink-light: "#1e2227"
  ink-dark: "#f1f2f3"
  secondary-dark: "#c3c8ce"
  muted-light: "#5f656c"
  muted-dark: "#a0a7ae"
  divider-light: "#ebe8e3"
  divider-dark: "#2f343b"
  danger-fill: "#c9363b"
  danger-ink-light: "#b42328"
  danger-ink-dark: "#ff8a8d"
typography:
  display:
    fontFamily: "system-ui"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: "36px"
    letterSpacing: "-0.5px"
  headline:
    fontFamily: "system-ui"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "26px"
  navigation-title:
    fontFamily: "system-ui"
    fontSize: "18px"
    fontWeight: 600
  category-title:
    fontFamily: "system-ui"
    fontSize: "17px"
    fontWeight: 600
  item-title:
    fontFamily: "system-ui"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "system-ui"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
  field:
    fontFamily: "system-ui"
    fontSize: "16px"
    fontWeight: 400
  label:
    fontFamily: "system-ui"
    fontSize: "13px"
    fontWeight: 400
  tab-label:
    fontFamily: "system-ui"
    fontSize: "11px"
    fontWeight: 500
rounded:
  glyph: "10px"
  search: "11px"
  action: "12px"
  group: "14px"
  sheet: "24px"
spacing:
  compact: "8px"
  row-gap: "12px"
  control-inset: "14px"
  row-inset: "16px"
  page-inset: "20px"
  minimum-touch: "44px"
components:
  primary-action:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.white}"
    typography: "{typography.item-title}"
    rounded: "{rounded.action}"
    padding: "{spacing.control-inset}"
    height: "50px"
  secondary-action:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-light}"
    typography: "{typography.item-title}"
    rounded: "{rounded.action}"
    padding: "{spacing.control-inset}"
    height: "50px"
  group:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.group}"
  field:
    backgroundColor: "{colors.inset-light}"
    textColor: "{colors.ink-light}"
    typography: "{typography.field}"
    rounded: "{rounded.group}"
    padding: "13px 14px"
    height: "50px"
  search-trigger:
    backgroundColor: "{colors.inset-light}"
    textColor: "{colors.muted-light}"
    typography: "{typography.field}"
    rounded: "{rounded.search}"
    padding: "0 14px"
    height: "46px"
  category-select:
    textColor: "{colors.ink-light}"
    typography: "{typography.category-title}"
    height: "46px"
  tab-bar:
    backgroundColor: "{colors.white}"
    textColor: "{colors.muted-light}"
    typography: "{typography.tab-label}"
  file-row:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-light}"
    typography: "{typography.item-title}"
    padding: "{spacing.control-inset}"
    height: "78px"
---

# Design System: My Secret Mobile

## Overview

The vault opens on its contents. A compact title bar and quiet grouped rows help people find, inspect, and copy items, then return to where they were.

The transparent ghost and orange accents carry the My Secret identity. Native stacks, tabs, keyboards, and pickers give the app familiar behavior on iOS and Android.

- Warm neutral light surfaces and charcoal dark surfaces follow device appearance.
- System typography and recognizable Lucide glyphs keep rows easy to scan.
- A category dropdown, one global search, and a dedicated Files tab give each task a clear entry point.

## Colors

- **Primary fill** pairs deep orange with white for filled actions in both modes. This pair reaches approximately 4.71:1 contrast.
- **Link** uses a deeper orange in light mode and a lighter orange in dark mode. Use it for active tabs, navigation glyphs, and text actions such as Upload files and New folder.
- **Selection** is a soft orange wash for selected item rows. Keep the row text in the normal foreground colors.
- **Canvas, surface, and inset** establish the page, grouped content, and recessed controls. The light surface is white. The dark surface sits between the charcoal canvas and the foreground ink.
- **Ink, muted, and divider** distinguish readable values, supporting text, and separators. Dark mode has a separate secondary tone for glyphs. Light mode uses the same gray for secondary and muted roles.
- **Danger fill and ink** mark destructive controls and errors. Use the fill with white on a destructive button and the mode-specific ink for readable status text.

The palette mapping lives in [the mobile theme](src/theme.ts) and [the shared primitives](../../packages/ui/src/tokens.ts).

## Typography

Use the platform system face. The font family and pixel units in the frontmatter represent React Native defaults and logical units in panel previews.

- Use the display role for large screen headings, the headline role for section emphasis, and the 18-unit semibold navigation title in native headers.
- Use 16-unit semibold titles and 13-unit supporting text in vault and file rows. Grouped settings rows use regular-weight 16-unit labels.
- Use 15-unit body copy with a 22-unit line height and 16-unit field text. Keep labels, menu actions, and status messages short and in sentence case.
- Keep English as the default. Source interface strings from the dictionaries and leave space for Vietnamese text and system text scaling.

## Layout

Use one scrolling content column. The shared page caps its width at 720 logical units. Vault, Search, and Files lists cap it at 820. Both use 20-unit horizontal insets and center the column on wider screens. The category sheet centers at up to 600 units wide and caps its height at 80% of the viewport.

Use 44-unit targets for compact header controls. Let the main surfaces breathe through minimum heights of 54 for settings rows, 72 for vault items, and 78 for file entries. Respect safe areas and use keyboard-aware scrolling on forms.

## Elevation & Depth

Use surface color and half-unit dividers to show grouping. The navigation header sits flush against the canvas. The selector sheet uses a translucent black backdrop. Transient app notices use a soft black shadow with a 3-unit vertical offset, a 12-unit radius, and 0.12 opacity.

## Shapes

Use 10-unit corners for vault and file icon wells, 11 for search, 12 for actions, and 14 for grouped containers and shared fields. The category sheet has 24-unit top corners. Clip rows to their shared group and inset the divider inside settings groups.

## Components

### Actions and fields

Use the primary filled action for the next step and a neutral surface for a secondary action. The shared action uses a 50-unit minimum height and 16-unit semibold text with dimmed press and disabled states. Use a persistent field label, an accessible name, and a theme-aware input surface. Pair error ink with a short description of the problem.

### Vault and global search

Show the category dropdown alongside sort and more actions. The dropdown opens a labeled sheet with a checkmark on the selected category and counts below option labels. Its query field, when present, filters category choices. The vault search row and stack header buttons open the same global search modal. Show recent items before a query and the result count after typing. Details, file previews, and folders open above search so Back returns to the current results.

### Navigation

Vault, Files, Generator, Watchtower, and Settings are bottom tabs. Open detail and utility routes using the native stack. Keep vault unlock and account sign-in distinct. Use platform dialogs and system media or document pickers at their respective entry points.

### Files

Keep file entries and file folders in the Files tab and discoverable through global search. Give each folder view Upload files and New folder actions. List folders before files, show file size or child count when available, and pair the type glyph with a text label. Long press or the trailing menu opens Rename, Move, and Delete. The Move sheet lists eligible folders and the root. Preview available files and show stored metadata with concise availability copy for legacy records.

### Share item

Open Share item from eligible item details. Show a short explanation of who can view the copy, an expiration selector, and Create link. After creation, offer Copy link and Share link to open the system share sheet. Show expiry and Delete link for active links. The confirmation explains that revocation stops future access and that recipients may have saved a copy.

## Do's and Don'ts

- **Do** keep search, item actions, and reading order consistent across themes and device widths.
- **Do** use accessible labels for icon-only controls and keep icons decorative when visible text already names the action.
- **Do** use the ghost illustration for onboarding and empty states and Lucide glyphs for routine navigation and rows.
- **Do** use synthetic vault contents for review captures. Record coverage for each current build, device class, appearance, and text size that was checked.
