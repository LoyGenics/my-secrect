/**
 * Tiny React binding for @my-secrect/i18n.
 *
 * - `I18nProvider` holds the active locale and mirrors it to <html lang>
 *   (screen readers pick the right voice). Persisting the choice is the
 *   app's call: pass `onLocaleChange={storeLocale}` on web/desktop (the
 *   language switch also stores it), AsyncStorage on mobile.
 * - `useTranslation()` returns `{ locale, setLocale, t, tp, dict }`. Outside a
 *   provider it silently falls back to English — components must never crash
 *   for lack of a provider.
 * - `useLocale()` is what @my-secrect/ui components call so a whole app can
 *   switch language by wrapping its root once.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTranslator, defaultLocale, plural, type Dictionary, type Locale, type PluralForms } from './index';

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, ...args: Array<string | number>) => string;
  /** Plural-aware format of a `{ one, other }` entry: `tp(dict.health.itemsChecked, n)`. */
  tp: (forms: PluralForms, count: number, ...args: Array<string | number>) => string;
  dict: Dictionary;
}

const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => undefined,
  t: createTranslator(defaultLocale).t,
  tp: (forms, count, ...args) => plural(defaultLocale, forms, count, ...args),
  dict: createTranslator(defaultLocale).dict,
});

export function I18nProvider({
  initialLocale = defaultLocale,
  onLocaleChange,
  children,
}: {
  initialLocale?: Locale;
  onLocaleChange?: (locale: Locale) => void;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );
  const value = useMemo<I18nContextValue>(() => {
    const { t, dict } = createTranslator(locale);
    const tp = (forms: PluralForms, count: number, ...args: Array<string | number>) => plural(locale, forms, count, ...args);
    return { locale, setLocale, t, tp, dict };
  }, [locale, setLocale]);
  useEffect(() => {
    try {
      if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = locale;
    } catch {
      /* non-DOM (React Native) */
    }
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  return useContext(I18nContext);
}

/** Ambient locale for design-system components; `'en'` when no provider is mounted. */
export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
