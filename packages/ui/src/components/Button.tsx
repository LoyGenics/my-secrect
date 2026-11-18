import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cn } from '../utils';
import type { IconName } from '../icons';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * primary = the orange pill (one per view: the main action).
   * secondary = neutral pill. ghost = borderless, for toolbars.
   * danger = final destructive action (red pill, white label).
   * danger-outline = destructive but recoverable (quiet pill, danger ink).
   * link = inline text action.
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width button. */
  block?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  /** Leading Lucide glyph by semantic name. */
  icon?: IconName;
  /** Render as the child element (e.g. an <a>) instead of a <button>. */
  asChild?: boolean;
}

/**
 * Pill button with a sentence-case label. Hover lifts 1px, focus is the
 * orange ring, disabled is a flat grey pill. Native button semantics
 * (Enter/Space). `type` defaults to "button" so a button never submits a
 * form by accident; pass type="submit" explicitly.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block = false, loading = false, icon, asChild = false, className, children, disabled, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
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
      {loading ? <Icon name="spinner" size="sm" /> : icon ? <Icon name={icon} size="sm" /> : null}
      <Slottable>{children}</Slottable>
    </Comp>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'asChild'> {
  icon: IconName;
  /** Accessible name — required: an icon-only button must say what it does. Also shown as the native tooltip. */
  label: string;
}

/** Icon-only button. The label is mandatory (aria-label + title). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', className, ...rest },
  ref,
) {
  return (
    <Button ref={ref} variant={variant} aria-label={label} title={label} className={cn('ms-button--icon', className)} {...rest}>
      <Icon name={icon} size={rest.size === 'sm' ? 'sm' : 'md'} />
    </Button>
  );
});
