import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../utils';
import { Icon } from './Icon';

export interface FieldProps {
  /** Visible label (printed legend). Required — every control is labelled. */
  label: string;
  /** Helper text under the well. */
  hint?: ReactNode;
  /** Error text; marks the control aria-invalid and describes it. */
  error?: string;
  /** Visually hide the label (it stays in the accessibility tree). Prefer a visible label. */
  hideLabel?: boolean;
  /** Stable id for the control (kept for existing tests and `name`-based hooks); generated when omitted. */
  id?: string;
  /** No bottom margin (when the parent lays fields out with a gap). */
  flush?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Field: printed legend + well + hint/error. Associates <label htmlFor> with
 * the control's id, wires hint/error through aria-describedby, sets
 * aria-invalid on error and announces the error (role="alert"). The
 * placeholder is never the label (WCAG 1.3.1 / 3.3.2).
 */
export function Field({ label, hint, error, hideLabel = false, id, flush = false, children, className }: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const child = isValidElement(children)
    ? cloneElement(
        children as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>,
        { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined },
      )
    : children;
  return (
    <div className={cn('ms-field', flush && 'ms-field--flush', className)}>
      <label htmlFor={controlId} className={cn('ms-label', hideLabel && 'ms-sr-only')}>
        {label}
      </label>
      {child}
      {hint && !error && (
        <p id={hintId} className="ms-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="ms-field__error">
          <Icon name="error" size="sm" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Error state (also set by Field's `error`). */
  error?: boolean;
  /** Monospace well for secrets, keys, hashes and URLs. */
  mono?: boolean;
}

/** Recessed well. Render inside <Field> or give it aria-label / aria-labelledby. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ error, mono, className, ...rest }, ref) {
  return <input ref={ref} className={cn('ms-input', mono && 'ms-input--mono', className)} aria-invalid={error || undefined} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ error, mono, className, ...rest }, ref) {
  return <textarea ref={ref} className={cn('ms-input', mono && 'ms-input--mono', className)} aria-invalid={error || undefined} {...rest} />;
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

/** Native select in a well (native popup = correct keyboard, screen-reader and touch behaviour). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ error, className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn('ms-input', className)} aria-invalid={error || undefined} {...rest}>
      {children}
    </select>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visible label; clicking it toggles the box. */
  label: ReactNode;
  /** Secondary line under the label. */
  hint?: ReactNode;
}

/** Native checkbox in a well; checked = solid ink square with a printed tick (no colour needed). */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, hint, className, ...rest }, ref) {
  return (
    <label className={cn('ms-checkbox', className)}>
      <input ref={ref} type="checkbox" {...rest} />
      <span className="ms-checkbox__text">
        {label}
        {hint && <span className="ms-checkbox__hint">{hint}</span>}
      </span>
    </label>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label (also the accessible name). */
  label: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Physical switch: role="switch" with aria-checked; Space/Enter toggle
 * (native button). The knob travels 18px with a detent; the LED lights
 * green when on, so state never depends on knob position alone.
 */
export function Switch({ checked, onCheckedChange, label, disabled, id, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      className={cn('ms-switch', className)}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="ms-switch__track" aria-hidden="true">
        <span className="ms-switch__knob" />
      </span>
      <span>{label}</span>
      <span className={cn('ms-led', 'ms-switch__led', checked && 'ms-led--ok')} aria-hidden="true" />
    </button>
  );
}
