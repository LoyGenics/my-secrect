import type { ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (required — Radix enforces Title). */
  title: string;
  description?: string;
  children: ReactNode;
  /** Locale override for the built-in close label. */
  locale?: Locale;
  closeLabel?: string;
  className?: string;
}

/**
 * Modal dialog on Radix Dialog: focus trap, Escape to close, overlay click
 * to close, focus return on close, aria-modal + labelledby. The close
 * button is always present with a localized accessible name. Content scrolls
 * when taller than the viewport. Do not nest dialogs.
 */
export function Dialog({ open, onOpenChange, title, description, children, locale, closeLabel, className }: DialogProps) {
  const strings = useUiStrings({ locale });
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ms-dialog-overlay" />
        <RadixDialog.Content className={cn('ms-dialog', className)}>
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

export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('ms-dialog__actions', className)}>{children}</div>;
}
