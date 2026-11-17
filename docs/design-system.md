# Design System — as it actually exists today

> Phase A audit, 17 Nov 2026. There is no "My Secret Design System" package.
> `packages/ui/src/index.ts` is literally `export {};` (182 bytes, with a
> comment saying shared components are extracted "only when 2+ apps need
> the same one"). What follows is what each app actually does — three
> divergent implementations of one intended dark theme.

## 1. Tokens that actually exist (desktop = source of truth)

From `apps/desktop/tailwind.config.js` + `apps/desktop/src/index.css`:

| Token | Value | Where |
|---|---|---|
| Background | `#0B0F14` | `body`, tailwind `slate.950` |
| Surface / card | `bg-zinc-900/70`, border `zinc-800` | `.card` |
| Text | `#F4F4F5` (`zinc-100`) | `body` |
| Muted text | `zinc-400`/`zinc-500` | `.label`, placeholders |
| Accent | `#6366F1` indigo-500/600 (`accent.DEFAULT`) | `.btn-primary`, focus rings |
| Accent hover | `#4F46E5` | tailwind `accent.hover` |
| Accent soft | `#312E81` | tailwind `accent.soft` |
| Danger | red-900/60 bg, red-200 text | `.btn-danger` |
| Success / warn | emerald-400/500, amber-400/500 (score only) | `HealthView.tsx` |
| Font | system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif | tailwind `fontFamily.sans` |
| Radius | `rounded-lg` (8 px) controls, `rounded-xl` (12 px) cards | `.card/.btn/.input` |
| Focus | 2 px indigo ring, offset 2 px | `:focus-visible` |

Component classes defined once in desktop `index.css` (`@layer components`):
`.card`, `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.input`,
`.label` (uppercase, tracking-wide, xs), `.gradient-subtle`,
`.nav-item`, `.nav-item-active`. Dark-only (`color-scheme: dark`); no light mode.

## 2. Mobile — a faithful parallel, not a shared system

`apps/mobile/src/theme.ts` re-declares the palette by hand:
`bg #0B0F14`, `card #151B23`, `cardBorder #262E3A`, `input #1B222C`,
`text #F4F4F5`, `muted #9CA3AF`, `faint #6B7280`, `accent #6366F1`,
`accentSoft rgba(99,102,241,0.22)`, `danger #EF4444`, `warn #F59E0B`,
`ok #10B981`. Radii 12/16, min touch targets 48–52 px, shared `styles`
(screen/container/card/title/subtitle/label/input/buttons/chip/error).
Values match desktop intent but are duplicated literals — a token change
must be edited in two places (three, counting web).

## 3. Web — same shell, divergent accent (token drift, verified)

`apps/web/src/App.tsx` renders the desktop `App` verbatim, but
`apps/web/src/index.css` redefines the shared classes: `.btn` becomes
**sky-600** (not indigo-600), focus ring **sky-400** (not indigo-500),
`.card` gains `p-4`. Net effect: the web client looks different from
the desktop client (sky vs indigo primary buttons) with no design decision
recorded. Web adds only `.web-shell` responsive rules (stack below 900 px)
and the amber banner. `apps/web/tailwind.config.js` (233 bytes) was not
line-read; it does not carry the desktop `accent` extension as far as the
CSS shows.

## 4. Extension popup — fourth implementation

`apps/extension/src/popup/popup.css` (1,472 bytes) + a 145-byte
`tailwind.config.js`; `Popup.tsx` uses `btn`/`input`/`label` class names
against its own stylesheet. Not line-read in full; visually it follows the
same dark/indigo direction but is not token-linked to desktop.

## 5. What exists per app (components)

- Desktop (9 components): `Sidebar` (8 categories, unicode glyphs
  ◈ ▣ ◉ `</>` ✎ ▦ ▤ ▧ — no icon set), `ItemList`, `ItemDetail`, `ItemForm`,
  `SearchPalette` (Cmd/Ctrl+K), `HealthView`, `SettingsView`,
  `PasswordGenerator`, `StrengthMeter`. `MediaView` + `SharesView` exist
  but are never rendered.
- Mobile (10 screens + `Field`, `ItemRow`, `StrengthMeter`): Vault, Search,
  Generate, Health, Settings, Lock, Onboarding, ItemDetail, ItemForm, Trash.
  Every input has a visible label, `accessibilityLabel`, and `testID`.
- Extension: popup (lock/create/list/fill/detail/add/health/settings),
  options page (`Options.tsx`, 9.8 KB).
- Labels: desktop inputs are labelled (`<label>` + `aria-label` on
  search/auto-lock); mobile uses `accessibilityLabel`/`testID` throughout.
  No accessibility audit has been run.

## 6. Gaps vs the intended My Secret Design System

1. **No token package.** `packages/ui` is empty; tokens live as literals
   in 4 stylesheets. No single source of truth for color, type, spacing,
   radius, or motion.
2. **Accent drift.** Desktop indigo `#6366F1` vs web sky `#38BDF8`/
   sky-600 buttons. Pick one; delete the other.
3. **No typography scale.** Only `title 24/700`, `subtitle 14/20`
   (mobile) and ad-hoc `text-sm/xs/4xl` (desktop). No documented scale.
4. **No icon system.** Sidebar uses unicode glyphs; no icon component.
5. **No light mode, no density variants, no motion guidance.**
6. **No shared components.** `ItemForm` field tables, health scoring UI,
   and strength meters are duplicated per app with slightly different
   rules (e.g. desktop health counts weak logins only; extension health
   counts any item with a short password).
7. **No component documentation or Storybook-style catalogue.**

## 7. Recommendation (Phase B, design)

Create `packages/ui` for real: `tokens.ts` (colors, radii, type, spacing),
then extract `Button/Input/Card/Label/StrengthMeter` from desktop
`index.css` and make web + extension consume them (web keeps only
`.web-shell` layout + banner). Resolve the indigo-vs-sky decision first;
until then the web client is visually a different product.
