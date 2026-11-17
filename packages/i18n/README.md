# @my-secrect/i18n — English + Vietnamese

Dependency-free core (`src/index.ts`) + a tiny React binding (`src/react.tsx`).
Nothing in this package touches crypto: it only translates display strings
and formats display dates/numbers with `Intl`.

## Locales

| Locale | Code | Dictionary |
|---|---|---|
| English (default) | `en` | `src/en.ts` — source of truth for keys |
| Vietnamese | `vi` | `src/vi.ts` — must satisfy the `Dictionary` type from `en.ts` |

`vi.ts` is type-checked against `en.ts`: a missing or extra key is a compile
error, so the locales cannot drift apart silently. The brand name "My Secret"
is a proper noun and is not translated.

## Usage

```ts
import { createTranslator, detectLocale, formatDate } from '@my-secrect/i18n';

const { t } = createTranslator('vi');
t('common.save'); // 'Lưu' in Vietnamese
t('nav.vault');   // 'Kho'
formatDate('vi', new Date()); // vi-VN date
```

React (wrap the app root once; screens then switch language app-wide):

```tsx
import { I18nProvider, useTranslation } from '@my-secrect/i18n/react';

<I18nProvider initialLocale={detectLocale()} onLocaleChange={persistChoice}>
  <App />
</I18nProvider>

const { t, locale, setLocale } = useTranslation();
```

`useTranslation()` outside a provider falls back to English instead of crashing.
Design-system components in `@my-secrect/ui` read the ambient locale with
`useLocale()` and accept per-component string overrides.

## Rules

1. No hardcoded UI strings in new code. Every user-facing string goes
   through `t('section.key')` or a dictionary lookup. If a string has no key,
   add the key to `en.ts` first, then to `vi.ts`.
2. Never localize crypto formats or data. Keys, ciphertext, hashes, TOTP
   secrets, recovery codes, vault payloads and wire formats are
   locale-invariant byte strings — never pass them through `t()` or `Intl`.
   Only display strings, display dates, display numbers and relative times
   are localized.
3. Interpolation is positional (`{0}`, `{1}`): `t('key', value)`. Never
   build a sentence by concatenating translated fragments — word order
   differs between English and Vietnamese.
4. Plurals/dates/numbers use `Intl`, not hand-rolled `if (n === 1)`
   branches (Vietnamese plural rules differ from English).
5. Adding a locale: add the file (e.g. `src/fr.ts`), add the code to
   `Locale` in `src/index.ts`, to `supportedLocales`, and to `getDictionary` /
   `normalizeLocale`. The `Dictionary` type forces full coverage.

## Migration path for existing screens (not done in Phase D)

Existing screens (desktop `App.tsx`, mobile screens, extension popup) still
contain hardcoded English strings — rewriting them is another agent's scope.
The adoption path, per screen:

1. Wrap the app root in `<I18nProvider initialLocale={stored ?? detectLocale()}>`.
2. Replace string literals with `t('...')`, adding keys to `en.ts`/`vi.ts` first.
   Group keys by screen/section (`vault.*`, `lock.*`, `settings.*`).
3. Replace hand-formatted dates/numbers with `formatDate` / `formatNumber` /
   `formatRelativeTime`.
4. Persist the locale choice in the app's settings store (vault settings on
   desktop/mobile; `chrome.storage` in the extension) and restore it at startup.
5. Do not translate: vault item field values, passwords, secrets,
   TOTP URIs, export file contents, or log messages.

## Verification (not run in Phase D — nothing is built/tested on the Mac)

```sh
npm install                # from the repo root; links the workspace
npm --workspace @my-secrect/i18n run typecheck
```
