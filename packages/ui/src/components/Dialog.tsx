import type { ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { IconButton } from './Button';

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
 * Modal plate on Radix Dialog: focus trap, Escape, overlay click, focus
 * return, aria-modal + labelledby. The close key always has a localized
 * name. Use only when the task needs protected focus; prefer inline UI.
 */
export function Dialog({ open, onOpenChange, title, description, children, locale, closeLabel, className }: DialogProps) {
  const strings = useUiStrings({ locale });
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ms-dialog-overlay" />
        <RadixDialog.Content className={cn('ms-dialog', className)} {...(description ? {} : { 'aria-describedby': undefined })}>
          <RadixDialog.Title className="ms-dialog__title">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="ms-dialog__description">{description}</RadixDialog.Description>
          ) : null}
          {children}
          <RadixDialog.Close asChild>
            <IconButton className="ms-dialog__close" icon="close" label={closeLabel ?? strings.dialog.close} size="sm" />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('ms-dialog__actions', className)}>{children}</div>;
}
