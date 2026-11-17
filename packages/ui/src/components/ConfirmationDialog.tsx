import type { ReactNode } from 'react';
import type { Locale } from '@my-secrect/i18n';
import { Button } from './Button';
import { Dialog, DialogActions } from './Dialog';
import { useUiStrings } from '../useUiStrings';

export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  /** Confirm button label. Defaults to the localized 'Delete'. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' (default) or 'primary'. Destructive actions stay danger. */
  tone?: 'danger' | 'primary';
  /** Runs on confirm, then closes. While it runs the confirm button shows loading. */
  onConfirm: () => void | Promise<void>;
  locale?: Locale;
  confirmLoading?: boolean;
}

/**
 * Confirmation dialog for destructive / irreversible actions (delete,
 * wipe, revoke). Built on Dialog (focus trap, Escape, labelled title).
 * The confirm button is danger-styled by default and autofocused NO —
 * focus starts on Cancel (the safe action) so an accidental Enter does
 * not destroy data. Cancel is always available via Escape / overlay / X.
 */
export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  onConfirm,
  locale,
  confirmLoading = false,
}: ConfirmationDialogProps) {
  const strings = useUiStrings({ locale });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} locale={locale}>
      {body && <p className="ms-dialog__description">{body}</p>}
      <DialogActions>
        <Button variant="secondary" autoFocus onClick={() => onOpenChange(false)}>
          {cancelLabel ?? strings.common.cancel}
        </Button>
        <Button
          variant={tone === 'danger' ? 'danger' : 'primary'}
          loading={confirmLoading}
          onClick={async () => {
            await onConfirm();
            onOpenChange(false);
          }}
        >
          {confirmLabel ?? strings.confirmation.confirmDelete}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
