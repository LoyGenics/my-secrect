import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../utils';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Element to render: `section` when the plate is a region with a heading (pair it with aria-labelledby). */
  as?: 'div' | 'section' | 'article' | 'aside';
  /** Inner padding: none 0, sm 12, md 16 (default), lg 20. */
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

/**
 * Card: white surface, 1px hairline, 20px radius, one gentle shadow
 * (hairline only on the dark theme). Never nest cards.
 */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Tag = 'div', padding = 'md', className, children, ...rest },
  ref,
) {
  return (
    <Tag
      ref={ref as never}
      className={cn('ms-card', padding !== 'md' && `ms-card--pad-${padding}`, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
});
