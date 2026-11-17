/**
 * Hook shared by all @my-secrect/ui components that render built-in strings.
 * Resolution order: explicit `overrides` prop > ambient locale from
 * `I18nProvider` > English default. No component hardcodes a UI string;
 * every default comes from the @my-secrect/i18n dictionaries.
 */
import { getDictionary, type Dictionary, type Locale } from '@my-secrect/i18n';
import { useLocale } from '@my-secrect/i18n/react';

export function useUiStrings(overrides?: { locale?: Locale }): Dictionary {
  const ambient = useLocale();
  return getDictionary(overrides?.locale ?? ambient);
}
