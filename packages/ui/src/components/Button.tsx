import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width button. */
  block?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  /** Render as a child element (e.g. an <a>) instead of a <button>. */
  asChild?: boolean;
}

/**
 * Button. Keyboard: native button semantics (Enter/Space), visible
 * :focus-visible ring from tokens.css. `loading` disables interaction and
 * announces busy state; `disabled` is native. Never put a <button> inside
 * a <button> — use `asChild` when the trigger must be a link.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block = false, loading = false, asChild = false, className, children, disabled, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(
        'ms-button',
        `ms-button--${variant}`,
        size !== 'md' && `ms-button--${size}`,
        block && 'ms-button--block',
        loading && 'ms-button--loading',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="ms-button__spinner" aria-hidden="true" />}
      {children}
    </Comp>
  );
});
