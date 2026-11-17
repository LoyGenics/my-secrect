import type { ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { IconButton } from './Button';

export type SheetSide = 'right' | 'left' | 'bottom';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (required). Set `hideTitle` to keep it for screen readers only. */
  title: string;
  hideTitle?: boolean;
  description?: string;
  children: ReactNode;
  side?: SheetSide;
  /** Drop the inner padding (for full-bleed content such as the navigation rail). */
  flush?: boolean;
  locale?: Locale;
  closeLabel?: string;
  className?: string;
}

/**
 * Drawer on Radix Dialog (focus trap, Escape, overlay close, focus return).
 * `left` hosts the phone navigation drawer, `bottom` phone action sheets.
 */
export function Sheet({ open, onOpenChange, title, hideTitle, description, children, side = 'right', flush, locale, closeLabel, className }: SheetProps) {
  const strings = useUiStrings({ locale });
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ms-sheet-overlay" />
        <RadixDialog.Content
          className={cn('ms-sheet', side !== 'right' && `ms-sheet--${side}`, flush && 'ms-sheet--flush', className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <RadixDialog.Title className={cn('ms-dialog__title', hideTitle && 'ms-sr-only')}>{title}</RadixDialog.Title>
          {description ? <RadixDialog.Description className="ms-dialog__description">{description}</RadixDialog.Description> : null}
          {children}
          <RadixDialog.Close asChild>
            <IconButton className="ms-dialog__close" icon="close" label={closeLabel ?? strings.dialog.close} size="sm" />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
