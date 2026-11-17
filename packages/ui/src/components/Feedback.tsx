import type { ReactNode } from 'react';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { Button } from './Button';

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

/**
 * Loading placeholder. `aria-busy` + role="status" so screen readers hear
 * "loading" once instead of silence; the shimmer is pure decoration
 * (aria-hidden). Use one per line of expected content, matching its shape.
 */
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
  /** Accessible name (e.g. 'Vault health', 'Upload progress'). */
  label: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  /** Indeterminate (unknown duration) — no value, animated. */
  indeterminate?: boolean;
  className?: string;
}

/**
 * Progress bar: native role="progressbar" with aria-valuenow/min/max and
 * a visible label association via aria-label. Clamps to 0–100.
 */
export function Progress({ value, label, tone = 'brand', indeterminate = false, className }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      aria-valuetext={indeterminate ? undefined : `${Math.round(clamped)}%`}
      className={cn('ms-progress', tone !== 'brand' && `ms-progress--${tone}`, className)}
    >
      <div className="ms-progress__bar" style={{ width: indeterminate ? '40%' : `${clamped}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState / ErrorState
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  title?: string;
  body?: string;
  /** Decorative glyph/emoji (aria-hidden). Keep it non-essential. */
  icon?: string;
  primaryAction?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  locale?: Locale;
  children?: ReactNode;
}

/**
 * Empty state for lists with no content. Titles default to the localized
 * 'No items yet' strings; pass explicit title/body for search-no-results.
 */
export function EmptyState({ title, body, icon = '\u25CB', primaryAction, secondaryAction, locale, children }: EmptyStateProps) {
  const strings = useUiStrings({ locale });
  return (
    <div className="ms-state" role="status">
      <span className="ms-state__icon" aria-hidden="true">{icon}</span>
      <h3 className="ms-state__title">{title ?? strings.emptyState.noItemsTitle}</h3>
      <p className="ms-state__body">{body ?? strings.emptyState.noItemsBody}</p>
      {children}
      {(primaryAction || secondaryAction) && (
        <div className="ms-state__actions">
          {primaryAction && <Button variant="primary" onClick={primaryAction.onClick}>{primaryAction.label}</Button>}
          {secondaryAction && <Button variant="secondary" onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>}
        </div>
      )}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  body?: string;
  icon?: string;
  onRetry?: () => void;
  retryLabel?: string;
  onGoBack?: () => void;
  locale?: Locale;
  children?: ReactNode;
}

/**
 * Error state for failed loads. role="alert" announces it assertively.
 * Never render raw error objects / stack traces here — pass a safe,
 * localized message; log the technical detail elsewhere.
 */
export function ErrorState({ title, body, icon = '\u26A0', onRetry, retryLabel, onGoBack, locale, children }: ErrorStateProps) {
  const strings = useUiStrings({ locale });
  return (
    <div className="ms-state" role="alert">
      <span className="ms-state__icon" aria-hidden="true">{icon}</span>
      <h3 className="ms-state__title">{title ?? strings.errorState.title}</h3>
      <p className="ms-state__body">{body ?? strings.errorState.body}</p>
      {children}
      {(onRetry || onGoBack) && (
        <div className="ms-state__actions">
          {onRetry && <Button variant="primary" onClick={onRetry}>{retryLabel ?? strings.errorState.retry}</Button>}
          {onGoBack && <Button variant="secondary" onClick={onGoBack}>{strings.errorState.goBack}</Button>}
        </div>
      )}
    </div>
  );
}
