import type { ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';

export type SheetSide = 'right' | 'left' | 'bottom';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (required — Radix enforces Title). */
  title: string;
  description?: string;
  children: ReactNode;
  side?: SheetSide;
  locale?: Locale;
  closeLabel?: string;
  className?: string;
}

/**
 * Drawer / Sheet: a non-modal-feeling side panel built on Radix Dialog so
 * it keeps the same guarantees (focus trap, Escape, overlay close, focus
 * return). Use for detail panels and filters; use Dialog for decisions
 * that must block the user. `bottom` is the mobile/small-screen variant.
 */
export function Sheet({ open, onOpenChange, title, description, children, side = 'right', locale, closeLabel, className }: SheetProps) {
  const strings = useUiStrings({ locale });
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ms-sheet-overlay" />
        <RadixDialog.Content className={cn('ms-sheet', side !== 'right' && `ms-sheet--${side}`, className)}>
          <RadixDialog.Title className="ms-dialog__title">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="ms-dialog__description">{description}</RadixDialog.Description>}
          {children}
          <RadixDialog.Close asChild>
            <button type="button" className="ms-dialog__close" aria-label={closeLabel ?? strings.dialog.close}>
              {'\u00D7'}
            </button>
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
