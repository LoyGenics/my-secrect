# Design system — "Precision Instrument"

Status: implemented in `packages/ui` and adopted by the vault screens (desktop,
web mirror, mobile). Direction contract:
`apps/desktop/.impeccable/surfaces/apps-desktop-src-app-tsx.md`. Product truth:
`PRODUCT.md`. This file replaces the Phase A audit that said `packages/ui` was empty.

## 1. Principles

- The vault is a precisely made personal device: two finishes of one object,
  **graphite** (dark, default) and **aluminium** (light).
- Colour is signal only: one **orange key** (`#FF5B1F`, primary action + focus)
  and **LEDs** (green ok, amber attention, red danger). Item types carry their own
  pastel code colour from the clay palette.
- Plates (flat machined panels, 1px hairline + 1px top highlight), molded **keys**
  (printed UPPERCASE legend, 1px lower edge; pressed drops 1px), recessed **wells**
  for inputs, rocker switches, LCD **readouts**. No gradients, glass or glow.
- Imagery (soft-3D clay) only on onboarding/splash, lock screen (>= 1024px), empty,
  error and success states and item-type art. Never in rows, never as an icon.

## 2. Tokens — one source

`packages/ui/src/tokens.ts` is the only place to change palette, type, radii or
motion. `tokens.css` is generated from it:

```sh
npm --workspace @my-secrect/ui run tokens      # rewrite src/tokens.css
npx tsx --test packages/ui/tests/tokens-sync.test.ts   # fails if stale (in npm test)
```

| Group | CSS variables | Notes |
|---|---|---|
| background | `--ms-color-bg-{base,surface,raised,sunken,input,muted}` | base = chassis, surface = plate, input = well |
| text | `--ms-color-text-{primary,secondary,muted,faint,on-brand,on-danger,on-module,link}` | faint is decoration only (< 4.5:1) |
| border | `--ms-color-border-{default,strong,subtle,control}` | control is the only >= 3:1 border (wells, switches) |
| brand | `--ms-color-brand[-hover,-active,-soft,-soft-text,-focus]` | legend on orange is ink, never white (3.10:1) |
| danger / success / warning | `--ms-color-{danger,success,warning}-*` | `*-text` / `danger-soft-text` are the text colours |
| led | `--ms-color-led-{ok,attention,danger,active,off}` | dots and segments only |
| focus | `--ms-color-focus-{ring,outline}` | aluminium adds an ink band (orange alone is 2.44:1 there) |
| edge | `--ms-color-edge-{highlight,key,key-brand,key-danger,well}` | machining |
| itemType | `--ms-color-type-<type>` | sky, mint, butter, coral, lavender, tangerine pastels |
| scale | `--ms-text-{legend,sm,md,lg,xl}` + `--ms-leading-*`, `--ms-radius-*`, `--ms-space-*`, `--ms-duration-{fast,base,slow,turn}`, `--ms-easing-*`, `--ms-control-height*` | five-step type scale, nothing else |

Type: system UI for body and fields; **Barlow Semi Condensed** (self-hosted via
`@fontsource`, OFL, Vietnamese subset) for legends and headings. Mobile keeps the
platform font with uppercase tracked legends.

Contrast (computed; rendered pairs checked by axe in both finishes): ink on plate
15.1 / 13.7:1, muted on well 5.0 / 6.8:1, legend ink on orange 5.5:1, white on
danger key 5.5:1, danger text 5.8 / 7.2:1, warning text 5.3 / 8.2:1.

## 3. Using it

Web/desktop code imports from `apps/desktop/src/theme.ts` (re-exports
`@my-secrect/ui` and loads `components.css` once — the web mirror gets it too).
Each app's `index.css` imports `tokens.css`. React Native imports
`packages/ui/src/native` (tokens, icon wrapper, modules, illustrations) and
`apps/mobile/src/theme.ts` (`useMobileTheme()`).

Rule: Tailwind is for layout only (flex, grid, gap, width). Colour, type and
spacing that a component owns come from its props/classes — a Tailwind utility
cannot reliably override a `.ms-*` property in the web build (stylesheet order
differs), which is why `Field` has `flush` and `Card` has `padding`.

## 4. Component contracts (`packages/ui/src/components`)

| Component | Contract |
|---|---|
| `Button` | Molded key. `variant`: `primary` (orange — one per view), `secondary` (neutral, default), `ghost`, `danger` (final, red key), `danger-outline` (recoverable destructive: red LED + danger legend), `link`. `size` sm/md/lg, `block`, `loading` (spinner, `aria-busy`, disabled), `icon` (leading Lucide name), `asChild`. `type` defaults to `button`. 36px (48px on coarse pointers). |
| `IconButton` | Icon-only key; `label` is required (aria-label + title). |
| `Icon` | The only icon component (lucide-react). `name` from `icons.ts`, `size` token, one stroke width; decorative unless `label`. Native twin: `native/Icon` (lucide-react-native), same names. |
| `Card` | Plate. `as` (div/section/article/aside), `padding` none/sm/md/lg. Never nest plates. |
| `Field` | Label (printed legend) + control + hint/error. Wires `htmlFor`/`id`, `aria-describedby`, `aria-invalid`; error is `role="alert"`. `id` keeps stable ids for tests; `flush` drops the bottom margin. |
| `Input`, `Textarea`, `Select` | Recessed wells; `mono` for secrets/keys/URLs; always inside `Field` or with `aria-label`. |
| `SecureField` | Password well with a reveal key (`aria-pressed`, localized name, keeps focus). |
| `SearchField` | `role="searchbox"`, clear key returns focus. |
| `Checkbox` | Native input in a well; checked = ink square with a printed tick. `label`, `hint`. |
| `Switch` | Physical switch: `role="switch"`, `aria-checked`, LED lights green when on. |
| `SegmentedControl` | Rocker: radiogroup, roving tabindex scoped to the group, arrows move + select, selected segment raised with an orange LED. |
| `Led`, `LedStrip`, `Readout`, `Badge`, `Kbd` | Signal primitives. LEDs are aria-hidden — always pair with text. `LedStrip` states: off/locked/working/error/turn/open. `Readout` = LCD tabular numerals. |
| `TypeModule` | Item-type module: silhouette (`modules.ts`) + code colour + Lucide glyph; identical in rail, list and mobile. |
| `ItemTypeArt` | Detail-header art slot: clay object from `typeArt`, falls back to `TypeModule`. |
| `Art` | Decorative illustration; animated slots render a `<picture>` that serves the still first frame under `prefers-reduced-motion`. |
| `Alert` | Notice plate: LED + text, tone info/success/warning/danger, `announce` → `role="alert"` (danger) or `"status"`, optional `action`. |
| `Dial` | Watchtower instrument: 240° scale, LED-coloured arc by band, LCD readout; `role="meter"`. |
| `Progress`, `Skeleton` | Bar in a well (`role="progressbar"`, animates transform); loading placeholder with `aria-busy`. |
| `EmptyState`, `ErrorState` | One illustration, title, one sentence, action(s), optional note. Error is `role="alert"`. |
| `Dialog`, `Sheet`, `ConfirmationDialog` | Radix Dialog: focus trap, Escape, focus return, required title, localized close key. Sheet `side` right/left/bottom, `flush`, `hideTitle`. Confirmation focuses Cancel first. |
| `CommandPalette` | Top-anchored plate; combobox + listbox, `aria-activedescendant`; `keywords`, `leading`, `meta`, `limit`, `title`, `emptyLabel(query)`. |
| `DropdownMenu`, `Tabs`, `Tooltip`, `Toast` | Radix primitives in the instrument grammar; tooltips never carry essential information. |
| `copyWithClear` / `useClipboardStatus` | Copy and clear the clipboard after 30 s even if the view unmounts; drives the "Copied · clears in Ns" LED. |

Layout classes (in `components.css`): `ms-app` shell (rail | main), `ms-rail`
(desktop rail, 768–1023 px icon rail with labels kept as accessible names, phone
drawer `ms-rail--drawer`), `ms-topbar`, `ms-split` list | detail (phones push the
detail, `data-pushed`), `ms-tabbar` (phone bottom tabs), `ms-action-rail` (phone
thumb-reach keys), `ms-spec` (spec-sheet detail), `ms-device` (lock / onboarding
face), `ms-keyturn` (unlock overlay), `ms-banner` / `ms-footer` (web frame).

## 5. Motion

120–180 ms ease-out detents, no bounce. Signature: the unlock **key turn** — LED
strip sweeps amber → orange → green and the device face slides away (280 ms).
Copy feedback lights the field's LED. Under `prefers-reduced-motion`: overlays
crossfade, nothing slides, scales, shimmers or loops; animated illustrations show
their first frame.

## 6. Imagery

`packages/ui/src/illustrations.ts` (web) and `src/native/illustrations.ts` map
slots to files; swapping art is a path change. Provenance per file (model, seed,
prompt id, licence): `packages/ui/assets/ASSETS.md`; licences:
`THIRD_PARTY_NOTICES.md`. The brand-mark slot (`brandMark`) is empty until the
logo is chosen.

## 7. Internationalisation

`packages/i18n` (en + vi). Components read strings via `useTranslation()` (typed
`dict`, `tp()` for plurals, `format()` for `{0}` placeholders). One
`I18nProvider` wraps the desktop/web app (`App.tsx`) and the mobile app; the
choice persists (`storeLocale` / AsyncStorage) and mirrors `<html lang>`.
`tests/parity.test.ts` enforces identical en/vi key sets, placeholders and plural
shape. Never translate vault content, keys, codes or file formats.

## 8. Accessibility verification

- `npm run test:a11y:web`: axe-core (WCAG 2.0/2.1/2.2 A + AA) against the
  production web build, both finishes, 1280 and 390 px, 11 screens; serious or
  critical violations fail.
- Keyboard: every rail entry, row, key and switch is a native button; skip link;
  focus mark visible on both finishes; sticky toolbars use scroll padding.

## 9. Adoption status

| Surface | Status |
|---|---|
| Desktop/web shell, lock, onboarding, restore, rail, list, detail, form, generator, Watchtower, settings, search, CSV import | On the design system + i18n |
| Security Center, sign-in, step-up, media, sharing, sync bar (owned elsewhere) | Legacy classes reskinned to the instrument grammar via `apps/desktop/src/index.css`; still carry hard-coded Tailwind zinc/indigo/amber classes and English strings |
| Mobile vault, search, trash, generator, health, detail, form, onboarding, restore, media | Instrument theme, Lucide, illustrations; strings partly English |
| Mobile lock, settings, sign-in, security, shares (owned elsewhere) | Static graphite theme; `FOLLOW_OS_APPEARANCE` stays off until they use `useMobileTheme()` |
| Extension | Not started |
