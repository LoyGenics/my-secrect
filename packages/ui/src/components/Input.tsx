import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../utils';

export interface FieldProps {
  /** Visible label text. Required for a11y — every input must be labelled. */
  label: string;
  /** Helper text shown under the field. */
  hint?: string;
  /** Error text; when set the field is marked aria-invalid and described by it. */
  error?: string;
  /** Hide the visual label but keep it for screen readers. Prefer a visible label. */
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Field wrapper: associates a <label> with its control via htmlFor/id,
 * wires hint/error text via aria-describedby, and marks errors with
 * aria-invalid. Use it for every form control; do not render a bare <input>
 * with a placeholder as its only label (WCAG 1.3.1 / 3.3.2).
 */
export function Field({ label, hint, error, hideLabel = false, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const child = isValidElement(children)
    ? cloneElement(
        children as ReactElement<{
          id?: string;
          'aria-describedby'?: string;
          'aria-invalid'?: boolean;
        }>,
        { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined },
      )
    : children;
  return (
    <div className={cn('ms-field', className)}>
      <label htmlFor={id} className="ms-label" style={hideLabel ? srOnlyStyle : undefined}>
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
          {error}
        </p>
      )}
    </div>
  );
}

const srOnlyStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Error state (also settable via Field's `error`). */
  error?: boolean;
}

/**
 * Text input. Always render inside <Field label="…"> (or pass an explicit
 * aria-label / aria-labelledby). Placeholder is never a label substitute.
 * Supports disabled, readOnly, required, autoComplete and error states.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error, className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn('ms-input', className)} aria-invalid={error || undefined} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { error, className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn('ms-input', className)} aria-invalid={error || undefined} {...rest} />;
});
