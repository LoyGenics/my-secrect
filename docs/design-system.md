# Design system — soft, light

Status: implemented in `packages/ui` and adopted by the vault screens (desktop,
web mirror, mobile). Direction contract:
`apps/desktop/.impeccable/surfaces/apps-desktop-src-app-tsx.md`. Product truth:
`PRODUCT.md`. This file replaces the Phase A audit that said `packages/ui` was empty.

## 1. Principles

- A calm, friendly place for everything private: **light by default** (warm
  body, white cards) with a matching **soft dark** theme. Mockup:
  `docs/mockups/ui-soft-v1.html`.
- Colour is signal: one **orange** (`#FF6A2B`, the primary action) and small
  status dots (green ok, amber attention, red danger). Each item type sits on one
  **pastel tile** (sky, mint, butter, coral, lavender, tangerine).
- Cards are white with a hairline, 20px radius and one gentle shadow; buttons
  are **pills** with sentence-case labels; fields are soft 44px fields; counts
  are quiet numbers. No UPPERCASE tracked labels, LEDs, metal edges or gradients
  (except the brand mark and the lock-screen backdrop).
- The 3D pictures appear on onboarding/splash, the lock screen (>= 1024px), empty,
  error and success states and on the **item-type tiles** (list rows and detail
  header). Never as an interface icon.

## 2. Tokens — one source

`packages/ui/src/tokens.ts` is the only place to change palette, type, radii or
motion. `tokens.css` is generated from it:

```sh
npm --workspace @my-secrect/ui run tokens      # rewrite src/tokens.css
npx tsx --test packages/ui/tests/tokens-sync.test.ts   # fails if stale (in npm test)
```

| Group | CSS variables | Notes |
|---|---|---|
| background | `--ms-color-bg-{base,surface,surface2,raised,sunken,input,muted}` | base = body, surface = cards, surface2 = sidebar and fields |
| text | `--ms-color-text-{primary,secondary,muted,faint,on-brand,on-danger,on-module,link}` | faint is decoration only (< 4.5:1) |
| border | `--ms-color-border-{default,strong,subtle,control}` | default = the hairline; control is the >= 3:1 edge of checkboxes and switch tracks |
| brand | `--ms-color-brand[-hover,-active,-soft,-soft-text,-focus]` | label on orange is ink, never white (2.86:1) |
| danger / success / warning | `--ms-color-{danger,success,warning}-*` | `*-text` / `danger-soft-text` are the text colours |
| led | `--ms-color-led-{ok,attention,danger,active,off}` | status dots, meter segments and the TOTP ring only (the name is historical) |
| focus | `--ms-color-focus-ring` | light uses a deeper orange (`#D4460E`, >= 3:1) |
| pastel | `--ms-color-pastel-{sky,mint,butter,coral,lavender,tangerine}` | tile colours; `--ms-color-type-<type>` points at one of them |
| shadow | `--ms-shadow-{sm,md}` | two levels: cards and selected rows; dialogs, menus, toasts |
| scale | `--ms-text-{legend,sm,md,lg,xl}` + `--ms-leading-*`, `--ms-radius-*`, `--ms-space-*`, `--ms-duration-{fast,base,slow,turn}`, `--ms-easing-*`, `--ms-control-height*` | five-step type scale, nothing else |

Type: the platform's rounded system face (`ui-rounded`, SF Pro Rounded, system-ui)
at a five-step scale, sentence case; nothing is downloaded. Radii 10 / 14 / 20 /
28 px and pills; motion 0.2s on `cubic-bezier(.2,.8,.2,1)`.

Contrast (computed; rendered pairs checked by axe in both themes): ink on card
16.7:1, quiet ink (`#5F656C`) on body 5.3:1, ink on the orange 5.5:1, white on the
danger button 5.2:1. Deviations from the mockup, for contrast: labels on orange are
ink not white (white is 2.86:1), `text.faint` (`#9AA0A6`) is for decoration and
disabled states only, links use a deeper orange (`#B83C0A`).

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
| `Button` | Pill. `variant`: `primary` (orange — one per view), `secondary` (neutral, default), `ghost`, `danger` (final, red), `danger-outline` (recoverable destructive: quiet, danger ink), `link`. `size` sm/md/lg, `block`, `loading` (spinner, `aria-busy`, disabled), `icon` (leading Lucide name), `asChild`. `type` defaults to `button`. 40px (48px on coarse pointers). |
| `IconButton` | Icon-only button; `label` is required (aria-label + title). |
| `Icon` | The only icon component (lucide-react). `name` from `icons.ts`, `size` token, one stroke width; decorative unless `label`. Native twin: `native/Icon` (lucide-react-native), same names. |
| `Card` | White card. `as` (div/section/article/aside), `padding` none/sm/md/lg. Never nest cards. |
| `Field` | Label + control + hint/error. Wires `htmlFor`/`id`, `aria-describedby`, `aria-invalid`; error is `role="alert"`. `id` keeps stable ids for tests; `flush` drops the bottom margin. |
| `Input`, `Textarea`, `Select` | Soft fields; `mono` for secrets/keys/URLs; always inside `Field` or with `aria-label`. |
| `SecureField` | Password field with a reveal button (`aria-pressed`, localized name, keeps focus). |
| `SearchField` | Pill, `role="searchbox"`, clear button returns focus. |
| `Checkbox` | Native input; checked = orange square with a tick. `label`, `hint`. |
| `Switch` | `role="switch"`, `aria-checked`; the track turns orange when on. |
| `SegmentedControl` | Pill track: radiogroup, roving tabindex scoped to the group, arrows move + select, the selected segment is a raised white pill. |
| `Led`, `LedStrip`, `Readout`, `Badge`, `Kbd` | Small primitives. `Led` is a status dot and `LedStrip` the lock-card dot (states off/locked/working/error/turn/open); both aria-hidden — always pair with text. `Readout` = quiet tabular count. |
| `TypeModule` | Item-type tile: the type's pastel with its 3D picture (`md` rows, `lg` detail); `sm` is a swatch with the Lucide glyph (sidebar, palette). Identical on mobile (`native/TypeModule`). |
| `ItemTypeArt` | The detail header's large tile (same as `TypeModule size="lg"`). |
| `Art` | Decorative illustration; animated slots render a `<picture>` that serves the still first frame under `prefers-reduced-motion`. |
| `Alert` | Notice: dot + text, tone info/success/warning/danger, `announce` → `role="alert"` (danger) or `"status"`, optional `action`. |
| `Dial` | Health score: soft 240° arc coloured by band, the score inside; `role="meter"`. |
| `Ring` | Countdown ring (TOTP): `role="progressbar"`, the arc shrinks as time runs out. |
| `Progress`, `Skeleton` | Rounded bar (`role="progressbar"`, animates transform); loading placeholder with `aria-busy`. |
| `EmptyState`, `ErrorState` | One illustration, title, one sentence, action(s), optional note. Error is `role="alert"`. |
| `Dialog`, `Sheet`, `ConfirmationDialog` | Radix Dialog: focus trap, Escape, focus return, required title, localized close key. Sheet `side` right/left/bottom, `flush`, `hideTitle`. Confirmation focuses Cancel first. |
| `CommandPalette` | Top-anchored card; combobox + listbox, `aria-activedescendant`; `keywords`, `leading`, `meta`, `limit`, `title`, `emptyLabel(query)`. |
| `DropdownMenu`, `Tabs`, `Tooltip`, `Toast` | Radix primitives in the soft grammar; tooltips never carry essential information. |
| `copyWithClear` / `useClipboardStatus` | Copy and clear the clipboard after 30 s even if the view unmounts; drives the "Copied · clears in Ns" chip. Web/desktop only — mobile does not clear the clipboard, so its copy feedback never says it does. |

Layout classes (in `components.css`): `ms-app` shell (rail | main), `ms-rail`
(sidebar, 768–1023 px icon rail with labels kept as accessible names, phone
drawer `ms-rail--drawer`), `ms-topbar` (hidden on list views from 768px, where the list column carries the title, new button and search), `ms-split` list | detail (phones push the
detail, `data-pushed`), `ms-tabbar` (phone bottom tabs), `ms-action-rail` (phone
thumb-reach buttons), `ms-spec` (item detail), `ms-device` (lock / onboarding
card), `ms-keyturn` (unlock overlay), `ms-banner` / `ms-footer` (web frame).

## 5. Motion

0.2s on one ease-out curve, no bounce. Signature: the unlock — the lock card's
status dot settles green and the card fades up and away (320 ms). Copying shows a
green "Copied" chip beside the value. Under `prefers-reduced-motion`: overlays
crossfade, nothing slides, lifts, shimmers or loops; animated illustrations show
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
  production web build, both themes, 1280 and 390 px, 11 screens; serious or
  critical violations fail.
- Keyboard: every rail entry, row, key and switch is a native button; skip link;
  focus ring visible on both themes; sticky toolbars use scroll padding.

## 9. Adoption status

| Surface | Status |
|---|---|
| Desktop/web shell, lock, onboarding, restore, sidebar, list, detail, form, generator, health, settings, search, CSV import | On the design system + i18n |
| Security Center, sign-in, step-up, media, sharing, sync bar | Legacy classes restyled in `packages/ui/src/legacy.css` (shared by desktop and web); hard-coded Tailwind colours replaced by token-backed `ms-*` colour names (`apps/desktop/tailwind.config.js`). Strings are in the dictionary (media view and sync bar included). |
| Mobile vault, search, trash, generator, health, detail, form, onboarding, restore, media | Soft light theme, pastel type tiles, safe-area frame (`components/ScreenFrame.tsx`), detail thumb bar. Vault, detail, media and the notices read strings from the dictionary; other screens are partly English |
| Mobile lock, settings, sign-in, security, shares | Static (light) theme; still mostly English strings. `FOLLOW_OS_APPEARANCE` stays off until every screen reads `useMobileTheme()`, so phones are light-only for now |
| Extension | Not started |
