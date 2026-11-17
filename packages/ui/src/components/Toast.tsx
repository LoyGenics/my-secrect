import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { Icon } from './Icon';
import { Led } from './Instrument';

export type ToastTone = 'info' | 'success' | 'danger';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss after ms. Default 5000; 0 means sticky (must be dismissed). */
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone' | 'duration'>> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Toast system on Radix Toast. Usage:
 *
 *   <ToastProvider><App /></ToastProvider>   // once, at the root
 *   const { toast } = useToast();
 *   toast({ title: t('common.saved'), tone: 'success' });
 *
 * Radix renders toasts in a Viewport with role="status" semantics:
 * success/info toasts are polite live regions, danger toasts assertive.
 * Each toast has a labelled dismiss button. `useToast()` outside a
 * provider returns a no-op (never throws) so components can call it
 * unconditionally.
 */
export function ToastProvider({
  children,
  locale,
  closeLabel,
}: {
  children: ReactNode;
  locale?: Locale;
  closeLabel?: string;
}) {
  const strings = useUiStrings({ locale });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback((input: ToastInput): number => {
    const id = nextId.current++;
    const item: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'info',
      duration: input.duration ?? 5000,
    };
    setToasts((list) => [...list.slice(-3), item]);
    return id;
  }, []);
  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((item) => (
          <RadixToast.Root
            key={item.id}
            open
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
            // duration 0 = sticky. Do NOT use Infinity here: Radix forwards
            // it to setTimeout, which clamps >2^31-1ms delays to 1ms and
            // would dismiss the toast immediately. 24h is effectively sticky.
            duration={item.duration === 0 ? 86_400_000 : item.duration}
            className={cn('ms-toast', item.tone !== 'info' && `ms-toast--${item.tone}`)}
          >
            <Led tone={item.tone === 'success' ? 'ok' : item.tone === 'danger' ? 'danger' : 'off'} />
            <div>
              <RadixToast.Title className="ms-toast__title">{item.title}</RadixToast.Title>
              {item.description && <RadixToast.Description className="ms-toast__description">{item.description}</RadixToast.Description>}
            </div>
            <RadixToast.Close className="ms-button ms-button--ghost ms-button--icon ms-button--sm ms-toast__close" aria-label={closeLabel ?? strings.toast.close}>
              <Icon name="close" size="sm" />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="ms-toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // No-op fallback: safe to call outside a provider (e.g. in tests).
    return { toast: () => -1, dismiss: () => undefined };
  }
  return ctx;
}
