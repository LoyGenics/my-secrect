import { forwardRef, type InputHTMLAttributes } from 'react';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { Icon } from './Icon';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
  /** Called when the clear button is pressed; the input is also cleared visually by the parent via `value`/`onChange`. */
  onClear?: () => void;
  /** Locale override; otherwise the ambient locale from I18nProvider. */
  locale?: Locale;
  placeholder?: string;
  clearLabel?: string;
}

/**
 * Search input: role="searchbox", type="search", with a clear button that
 * appears only when there is a value. The clear button has an accessible
 * name and returns focus to the input after clearing. The decorative
 * magnifier is aria-hidden. Always label it (Field or aria-label) — the
 * placeholder alone is not a label.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { onClear, locale, placeholder, clearLabel, className, value, onChange, ...rest },
  ref,
) {
  const strings = useUiStrings({ locale });
  const hasValue = value !== undefined && value !== '';
  return (
    <span className="ms-input-wrap ms-search-field">
      <span className="ms-search-field__icon" aria-hidden="true">
        <Icon name="search" />
      </span>
      <input
        ref={ref}
        type="search"
        role="searchbox"
        className={cn('ms-input', className)}
        placeholder={placeholder ?? strings.searchField.placeholder}
        value={value}
        onChange={onChange}
        {...rest}
      />
      {hasValue && onClear && (
        <button
          type="button"
          className="ms-input-wrap__button"
          aria-label={clearLabel ?? strings.searchField.clearSearch}
          onClick={(e) => {
            onClear();
            // Keep focus in the field so the user can type the next query.
            (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement | null)?.focus();
          }}
        >
          <Icon name="close" />
        </button>
      )}
    </span>
  );
});
