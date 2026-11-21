# @my-secrect/ui — My Secret Design System

The single source of truth for how My Secret looks and behaves.
Phase A found three divergent implementations of one intended dark theme
(desktop indigo, web sky, mobile hand-duplicated literals) and an empty
`packages/ui`. This package replaces them.

## What is in here

| File | What it is |
|---|---|
| `src/tokens.ts` | Platform-neutral token values (color, type, spacing, radii, shadows, motion, breakpoints, density). Importable from web, desktop **and** React Native. |
| `src/tokens.css` | The same tokens as CSS custom properties (`--ms-*`), light + dark themes, global focus ring, reduced-motion. |
| `src/fonts.css` | Be Vietnam Pro 400/500/600/700 (latin, latin-ext, vietnamese) from `@fontsource/be-vietnam-pro`, for web, desktop and the extension. Import once per app. |
| `src/theme.ts` | DOM theme helpers (`initTheme`, `applyTheme`, `resolveTheme`, storage). **Do not import from React Native.** |
| `src/components.css` | Styles for every component below, driven by the `--ms-*` variables. Plain CSS on purpose (see decisions). |
| `src/components/*` | Accessible React components on Radix primitives. Web/desktop only. |
| `src/useUiStrings.ts` | Hook resolving component strings from `@my-secrect/i18n` (ambient locale or per-component override). |

## Tokens

Brand is **indigo** (Tailwind indigo scale). The web sky accent was drift,
not a decision, and is removed.

- `background`: base `#0B0F14`, surface `#141519` (the exact blend of desktop's `bg-zinc-900/70` card over `#0B0F14`), raised `#1B222C`, sunken `#080B0F`, input `#18181B`.
- `text`: primary `#F4F4F5`, secondary `#D4D4D8`, muted `#A1A1AA`, faint `#71717A` (restricted — see contrast).
- `brand`: `500 #6366F1` is **not** a text-on-brand color; primary buttons use `600 #4F46E5`. `500` is for focus rings, large-text accents and decoration.
- Typography scale: display 32/40, title 24/32, heading 20/28, subheading 16/24, body 16/24, bodySmall 14/20, caption 12/16, label 12/16 uppercase (the desktop `.label`).
- Spacing: 4px base scale. Radii: 4/8/12/16/24/full (controls 8, cards 12, sheets 16).
- Motion: 120/200/320ms, standard easing; `prefers-reduced-motion` disables animation globally (tokens.css).
- Breakpoints: 640/768/1024/1280. Density: comfortable (40px controls, 48px touch) / compact (32px, pointer only).

### Contrast (WCAG 2.2 AA targets, computed from relative luminance)

Computed on the hex values in `tokens.ts` — **not verified in a browser**;
no browser test has been run, so do not claim a verified AA pass.

| Pair | Ratio | Verdict |
|---|---|---|
| Dark text primary `#F4F4F5` on `#0B0F14` | 17.49:1 | AAA |
| Dark text secondary `#D4D4D8` on `#0B0F14` | 13.00:1 | AAA |
| Dark text muted `#A1A1AA` on `#0B0F14` / on input `#18181B` | 7.50:1 / 6.91:1 | AAA |
| Dark text faint `#71717A` on `#0B0F14` | 3.98:1 | **Fails 4.5:1 — large text (3:1 bar) and decoration only** |
| White on brand-600 `#4F46E5` | 6.29:1 | AA |
| White on brand-500 `#6366F1` | 4.47:1 | **Fails 4.5:1 — never text-on-brand** |
| Focus ring brand-500 vs dark bg / brand-600 vs white | 4.30:1 / 6.29:1 | Passes 3:1 non-text |
| Light text primary `#18181B` on white | 17.72:1 | AAA |
| Light text secondary `#3F3F46` / muted `#52525B` on white | 10.44:1 / 7.73:1 | AAA |
| Light link brand-700 `#4338CA` on white | 7.90:1 | AAA |
| Danger white on `#DC2626` | 4.83:1 | AA |

Consequences baked into the tokens: placeholders use muted, never faint;
primary buttons use brand-600; faint is exported but documented restricted.

## Themes

- Default is **dark** (preserves the shipped desktop/web look). No visual change on upgrade.
- Light is opt-in: `applyTheme('light')` or `data-theme="light"` on `<html>`.
- `system` follows `prefers-color-scheme` (live-updates while in system mode).
- `initTheme()` at startup reads the stored mode (`localStorage`, key `my-secrect:theme`) and applies it. `themeInitScript` is an inline `<script>` string for `index.html` to avoid a theme flash (not applied yet — index.html files are out of Phase D scope).

```ts
import { initTheme, applyTheme } from '@my-secrect/ui/theme';
initTheme();                    // once, at startup
applyTheme('light');            // from a settings control
applyTheme('system');           // follow the OS
```

## Components

All web/desktop components. Mobile consumes **tokens only**, never DOM components.

| Component | Built on | Notes |
|---|---|---|
| `Button` | Radix Slot (`asChild`) | variants primary/secondary/ghost/danger/danger-outline; sizes sm/md/lg; `loading` spins + `aria-busy` + disables |
| `Card` | div | Token-driven successor of legacy `.card` |
| `Input`, `Textarea`, `Field` | native | `Field` wires label/htmlFor, hint/error via `aria-describedby`, `aria-invalid`, error `role="alert"` |
| `SecureField` | native | show/hide toggle: real button, `aria-pressed`, localized label, keeps input focus |
| `SearchField` | native | `role="searchbox"`, clear button only when valued, focus returns to input |
| `Dialog` (+ `DialogActions`) | Radix Dialog | focus trap, Esc, overlay close, focus return, required Title |
| `Sheet` (Drawer) | Radix Dialog | right/left/bottom; same guarantees as Dialog |
| `DropdownMenu` | Radix DropdownMenu | arrow keys, typeahead, Esc; items are localizable data |
| `Tabs` | Radix Tabs | WAI-ARIA tabs, arrow/Home/End |
| `SegmentedControl` | hand-rolled radiogroup | roving tabindex, arrows + Space/Enter |
| `Toast` (`ToastProvider`, `useToast`) | Radix Toast | polite/assertive live regions, max 4 stacked, sticky = 24h duration (see below) |
| `Tooltip` | Radix Tooltip | supplement only — never the sole label |
| `CommandPalette` (+ `useCommandPaletteHotkey`) | Radix Dialog + listbox | Cmd/Ctrl+K, `aria-activedescendant`, arrows/Enter/Esc |
| `Skeleton` | div | `role="status"`, `aria-busy` |
| `Progress` | div | `role="progressbar"`, clamped 0–100, indeterminate mode |
| `EmptyState`, `ErrorState` | div | `role="status"` / `role="alert"`; never render raw errors |
| `ConfirmationDialog` | Dialog | danger by default; focus starts on **Cancel** (safe action) |

### Accessibility contract (per component)

Keyboard operable, visible 2px focus ring, screen-reader label or name,
`disabled` and `loading` states, error states announced. No component
renders a built-in English string directly — strings come from
`@my-secrect/i18n` via `useLocale()` (ambient `I18nProvider` locale) with
per-component `locale` / label overrides.

**Not verified:** no browser, screen-reader or keyboard audit has been run.
The a11y statements here are design intent from the ARIA patterns used,
not test results. Before claiming WCAG conformance, run: keyboard-only
walkthrough, VoiceOver/NVDA pass, axe scan, and a forced-colors check.

## Usage (web/desktop)

```tsx
import '@my-secrect/ui/tokens.css';
import '@my-secrect/ui/components.css';
import { Button, Field, Input, ToastProvider, useToast } from '@my-secrect/ui';
```

Until the apps add the dependency (see below), desktop/web import the CSS
by relative path in their `index.css` (already done in Phase D).

## Adoption steps still needed (not Phase D scope)

1. `npm install` at the repo root (installs Radix deps + links workspaces).
2. Add `"@my-secrect/ui": "workspace:*"` and `"@my-secrect/i18n": "workspace:*"` to `apps/desktop/package.json` and `apps/web/package.json` (package.json files are not Phase D scope).
3. In each app's `tailwind.config.js`, add `'../../packages/ui/src/**/*.{ts,tsx}'` to `content` **only if** app code uses Tailwind classes alongside the components — the components themselves need no Tailwind config (plain CSS).
4. In `main.tsx`, call `initTheme()` and wrap the root in `<I18nProvider>` + `<ToastProvider>`.
5. Migrate screens one at a time from legacy `.btn`/`.input` classes to the components; keep the legacy classes until the last screen migrates (they are token-driven now, so both render identically).
6. Mobile: already consumes tokens via `apps/mobile/src/theme.ts`. No component adoption there by design.

## Design decision record (compact)

Adopted from:

- **shadcn/ui + Radix**: the composition model — unstyled, accessible primitives (Dialog, Menu, Tabs, Tooltip, Toast) + a thin token-driven style layer in our own CSS. Chosen because focus traps, portals and roving tabindex are easy to get wrong by hand, and Radix is the audited implementation. We did **not** adopt shadcn's Tailwind-utility styling: our components use plain CSS classes so they work without Tailwind `content` config.
- **1Password / Bitwarden**: vault UX conventions — show/hide secret fields with an explicit toggle, destructive confirmations that default focus to the safe action, health as a progress/score, and a command palette as the primary keyboard path. No visual copying; behavior only.
- **Apple HIG**: 44–48px minimum touch targets, system font stack, reduced-motion respect, `prefers-color-scheme` as the system-mode source.
- **Material 3**: tonal surfaces (base/surface/raised/sunken), the 4px spacing scale, and the 24px minimum target size as a floor (we ship 44px, stricter).
- **WCAG 2.2 AA**: the contrast budget above; focus visible (2.4.7), target size (2.5.8), reduced motion (2.3.3), status/error announcement (4.1.3).

Rejected / deferred:

- **cmdk** for the palette: one more overlay library for a filtered list; hand-rolled listbox on Radix Dialog is smaller and fully explicit.
- **Tailwind utilities inside components**: would silently break (unstyled output) in any app whose Tailwind `content` does not scan `packages/ui`. Plain CSS + variables cannot break that way.
- **Icon set**: the desktop sidebar still uses unicode glyphs. No icon dependency was added — that is a separate decision (license + bundle) for a later phase.
- **Storybook**: no catalogue yet; README + component props are the catalogue until an app needs visual review tooling.
- **Light-mode default**: dark stays the default so the upgrade is visually a no-op; light is a user choice, not a surprise.

## Verification (not run in Phase D — nothing is built/tested on the Mac)

```sh
npm install                                   # repo root; installs Radix + links workspaces
npm --workspace @my-secrect/ui run typecheck
npm --workspace @my-secrect/i18n run typecheck
npm --workspace @my-secrect/desktop run build  # after step 2 above
npm --workspace @my-secrect/web run build      # after step 2 above
npm --workspace @my-secrect/mobile run typecheck
```

Then: keyboard-only walkthrough, axe scan, VoiceOver/NVDA pass, and a
light/dark visual check in desktop + web. Record results in the UI README
or the repo docs — do not claim AA pass before that.
