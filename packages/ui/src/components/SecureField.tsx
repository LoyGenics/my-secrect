import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { Icon } from './Icon';

export interface SecureFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Error state (also settable via Field's `error`). */
  error?: boolean;
  /** Locale override; otherwise the ambient locale from I18nProvider. */
  locale?: Locale;
  /** String overrides for the show/hide toggle. */
  showLabel?: string;
  hideLabel?: string;
}

/**
 * Password / secret input with a show/hide toggle.
 *
 * - The toggle is a real <button type="button"> with an aria-label that
 *   flips between "Show password" / "Hide password" (localized), and
 *   aria-pressed reflecting the visible state.
 * - `type` flips between "password" and "text"; the value itself is never
 *   logged, copied or transformed by this component.
 * - The toggle never steals focus from the input on mouse click
 *   (onMouseDown preventDefault) so typing is uninterrupted.
 * - Always render inside <Field label="…"> like Input.
 */
export const SecureField = forwardRef<HTMLInputElement, SecureFieldProps>(function SecureField(
  { error, locale, showLabel, hideLabel, className, disabled, ...rest },
  ref,
) {
  const strings = useUiStrings({ locale });
  const [visible, setVisible] = useState(false);
  const label = visible
    ? hideLabel ?? strings.secureField.hidePassword
    : showLabel ?? strings.secureField.showPassword;
  return (
    <span className="ms-input-wrap">
      <input
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={cn('ms-input', className)}
        aria-invalid={error || undefined}
        disabled={disabled}
        {...rest}
      />
      <button
        type="button"
        className="ms-input-wrap__button"
        aria-label={label}
        aria-pressed={visible}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setVisible((v) => !v)}
      >
        <Icon name={visible ? 'hide' : 'show'} />
      </button>
    </span>
  );
});
