import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cn } from '../utils';
import type { IconName } from '../icons';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * primary = the orange key (one per view: the main action).
   * secondary = neutral key. ghost = unprinted key for toolbars.
   * danger = final destructive action (red key, white legend).
   * danger-outline = destructive but recoverable (neutral key, red LED + danger legend).
   * link = inline text action.
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width key. */
  block?: boolean;
  /** Shows a spinner, sets aria-busy and disables the key. */
  loading?: boolean;
  /** Leading Lucide glyph by semantic name. */
  icon?: IconName;
  /** Render as the child element (e.g. an <a>) instead of a <button>. */
  asChild?: boolean;
}

/**
 * Molded key. Printed UPPERCASE legend (CSS), 1px lower edge; pressed drops
 * 1px and loses the edge; focus is the orange ring (+ ink band on
 * aluminium); disabled is flat with a dashed hairline. Native button
 * semantics (Enter/Space). `type` defaults to "button" so a key never
 * submits a form by accident; pass type="submit" explicitly.
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
  /** Accessible name — required: an icon-only key must say what it does. Also shown as the native tooltip. */
  label: string;
}

/** Icon-only key. The label is mandatory (aria-label + title). */
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
