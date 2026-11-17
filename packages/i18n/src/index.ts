/**
 * @my-secrect/i18n — dependency-free core.
 *
 * Rules (see README.md):
 * 1. Every user-facing string lives in `en.ts` / `vi.ts`. Never hardcode a
 *    UI string in a component; use `t()` or a dictionary lookup.
 * 2. Localization never touches cryptographic formats or data: keys,
 *    ciphertext, hashes, TOTP secrets, recovery codes and vault payloads
 *    are locale-invariant byte strings and are never passed through `t()`
 *    or `Intl` formatters. Only display strings, dates, numbers and
 *    relative times are localized.
 * 3. Interpolation is positional (`{0}`, `{1}`) and values are inserted
 *    as-is — never build a sentence by concatenating translated fragments
 *    (word order differs between English and Vietnamese).
 */
import { en, type Dictionary } from './en';
import { vi } from './vi';

export { en, vi, type Dictionary };

export type Locale = 'en' | 'vi';

export const supportedLocales: readonly Locale[] = ['en', 'vi'] as const;
export const defaultLocale: Locale = 'en';

const dictionaries: Record<Locale, Dictionary> = { en, vi };

/** Return the dictionary for a locale. Unknown locales fall back to English. */
export function getDictionary(locale: string | undefined | null): Dictionary {
  if (locale === 'vi') return vi;
  return en;
}

/** Normalize a BCP 47 tag (`vi-VN`, `en-US`, …) to a supported locale. */
export function normalizeLocale(tag: string | undefined | null): Locale {
  if (!tag) return defaultLocale;
  const lower = tag.toLowerCase();
  if (lower.startsWith('vi')) return 'vi';
  if (lower.startsWith('en')) return 'en';
  return defaultLocale;
}

/**
 * Detect the user's locale without crashing outside a browser / in
 * React Native (where `navigator` may be absent or partial).
 * Never throws; defaults to English.
 */
export function detectLocale(): Locale {
  try {
    const nav =
      typeof navigator !== 'undefined' ? (navigator as { language?: string }) : undefined;
    return normalizeLocale(nav?.language);
  } catch {
    return defaultLocale;
  }
}

type NestedString = { [key: string]: string | NestedString };

/** Look up a dotted key (`'common.save'`) in a dictionary. Returns the key itself when missing (never throws, never renders blank). */
export function translate(locale: Locale, key: string): string {
  const dict = dictionaries[locale] as unknown as NestedString;
  let node: string | NestedString | undefined = dict;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object') node = (node as NestedString)[part];
    else return key;
  }
  return typeof node === 'string' ? node : key;
}

/**
 * Create a translator bound to one locale.
 * `t('common.save')` → `'Save'` / `'Lưu'`. Optional `{0}` interpolation:
 * `t('confirmation.deleteBody', itemName)` is NOT supported for sentences
 * with a name inside — add a dedicated key with a `{0}` placeholder instead.
 */
export function createTranslator(locale: Locale) {
  const t = (key: string, ...args: Array<string | number>): string => {
    let out = translate(locale, key);
    args.forEach((arg, i) => {
      // split/join instead of replaceAll: lib is ES2020 (replaceAll is ES2021).
      out = out.split(`{${i}}`).join(String(arg));
    });
    return out;
  };
  return { locale, t, dict: dictionaries[locale] };
}

export type Translator = ReturnType<typeof createTranslator>;

// ---------------------------------------------------------------------------
// Locale-aware formatting of DISPLAY values only (Intl). Never use these
// for crypto material, identifiers, or wire formats — those stay raw.
// ---------------------------------------------------------------------------

/** Format a Date for display in the user's locale (e.g. item updated time). */
export function formatDate(locale: Locale, date: Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', options).format(date);
}

/** Format a plain number for display (counts, scores). */
export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US').format(value);
}

/** Relative time for display ("2 hours ago" / "2 giờ trước"). */
export function formatRelativeTime(locale: Locale, date: Date, now: Date = new Date()): string {
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { numeric: 'auto' });
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return rtf.format(diffSeconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), 'hour');
  return rtf.format(Math.round(diffSeconds / 86400), 'day');
}
