import type { ReactNode } from 'react';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import type { IconName } from '../icons';
import { Button } from './Button';
import { Icon } from './Icon';
import { Art } from './Art';
import { illustrations, type ArtSource } from '../illustrations';

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export interface SkeletonProps {
  /** Width in px or CSS (e.g. '60%'). */
  width?: number | string;
  /** Height in px. Default 16. */
  height?: number;
  /** Accessible label for the loading region; defaults to localized 'Loading…'. */
  label?: string;
  locale?: Locale;
  className?: string;
}

/** Loading placeholder shaped like the content. role="status" + aria-busy; the pulse is decoration (stops under reduced motion). */
export function Skeleton({ width = '100%', height = 16, label, locale, className }: SkeletonProps) {
  const strings = useUiStrings({ locale });
  return (
    <div role="status" aria-label={label ?? strings.progress.loading} aria-busy="true" className={className}>
      <div className="ms-skeleton" aria-hidden="true" style={{ width, height }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressProps {
  /** 0–100. Values outside are clamped. */
  value: number;
  /** Accessible name (e.g. 'Vault health', 'Code refreshes'). */
  label: string;
  /** LED colour of the bar; default ink. */
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
  /** Optional aria-valuetext (e.g. '12 seconds left'). */
  valueText?: string;
  className?: string;
}

/** Bar in a recessed track: role="progressbar", clamped 0–100. */
export function Progress({ value, label, tone = 'neutral', valueText, className }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-valuetext={valueText ?? `${Math.round(clamped)}%`}
      className={cn('ms-progress', tone !== 'neutral' && `ms-progress--${tone}`, className)}
    >
      <div className="ms-progress__bar" style={{ width: `${clamped}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState / ErrorState
// ---------------------------------------------------------------------------

export interface StateAction {
  label: string;
  onClick: () => void;
  icon?: IconName;
}

export interface EmptyStateProps {
  title?: string;
  body?: ReactNode;
  /** Illustration slot from `illustrations` (empty, error and success states only). Decorative. */
  art?: ArtSource;
  /** Lucide glyph when there is no 3D object. */
  icon?: IconName;
  primaryAction?: StateAction;
  secondaryAction?: StateAction;
  /** Small print under the actions. */
  note?: ReactNode;
  /** Heading level for the title (default 2). */
  headingLevel?: 2 | 3;
  locale?: Locale;
  children?: ReactNode;
  className?: string;
}

/**
 * Empty / success state: one 3D object (or glyph), a title that says what
 * this place is for, one sentence on how to fill it, and the action. Not a
 * live region — it is page content.
 */
export function EmptyState({
  title,
  body,
  art,
  icon,
  primaryAction,
  secondaryAction,
  note,
  headingLevel = 2,
  locale,
  children,
  className,
}: EmptyStateProps) {
  const strings = useUiStrings({ locale });
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <div className={cn('ms-state', className)}>
      {art ? (
        <Art src={art} size={144} className="ms-state__art" />
      ) : icon ? (
        <Icon name={icon} size={32} className="ms-state__icon" />
      ) : null}
      <Heading className="ms-state__title">{title ?? strings.emptyState.noItemsTitle}</Heading>
      <p className="ms-state__body">{body ?? strings.emptyState.noItemsBody}</p>
      {children}
      {(primaryAction || secondaryAction) && (
        <div className="ms-state__actions">
          {primaryAction && (
            <Button variant="primary" icon={primaryAction.icon} onClick={primaryAction.onClick}>
              {primaryAction.label}
            </Button>
          )}
          {secondaryAction && (
            <Button variant="secondary" icon={secondaryAction.icon} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
      {note && <p className="ms-state__note">{note}</p>}
    </div>
  );
}

export interface ErrorStateProps {
  /** Illustration slot; defaults to `illustrations.error`. */
  art?: ArtSource;
  title?: string;
  body?: string;
  onRetry?: () => void;
  retryLabel?: string;
  onGoBack?: () => void;
  locale?: Locale;
  children?: ReactNode;
}

/** Failed load. role="alert". Never render raw error objects here — pass a safe, localized message. */
export function ErrorState({ art = illustrations.error, title, body, onRetry, retryLabel, onGoBack, locale, children }: ErrorStateProps) {
  const strings = useUiStrings({ locale });
  return (
    <div className="ms-state" role="alert">
      <Art src={art} size={144} className="ms-state__art" />
      <h2 className="ms-state__title">{title ?? strings.errorState.title}</h2>
      <p className="ms-state__body">{body ?? strings.errorState.body}</p>
      {children}
      {(onRetry || onGoBack) && (
        <div className="ms-state__actions">
          {onRetry && <Button variant="primary" icon="regenerate" onClick={onRetry}>{retryLabel ?? strings.errorState.retry}</Button>}
          {onGoBack && <Button variant="secondary" icon="back" onClick={onGoBack}>{strings.errorState.goBack}</Button>}
        </div>
      )}
    </div>
  );
}
