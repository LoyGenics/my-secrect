/**
 * Tiny React binding for @my-secrect/i18n.
 *
 * - `I18nProvider` holds the active locale (persist the choice in the app's
 *   own settings store; this package does not decide where it is stored).
 * - `useTranslation()` returns `{ locale, setLocale, t, dict }`. Outside a
 *   provider it silently falls back to English — components must never crash
 *   for lack of a provider.
 * - `useLocale()` is what @my-secrect/ui components call so a whole app can
 *   switch language by wrapping its root once.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createTranslator, defaultLocale, type Dictionary, type Locale } from './index';

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, ...args: Array<string | number>) => string;
  dict: Dictionary;
}

const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => undefined,
  t: createTranslator(defaultLocale).t,
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
    return { locale, setLocale, t, dict };
  }, [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  return useContext(I18nContext);
}

/** Ambient locale for design-system components; `'en'` when no provider is mounted. */
export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
