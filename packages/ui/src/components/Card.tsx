import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../utils';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {}

/**
 * Card: a surface container (bg-surface, 1px border, 12px radius, sm shadow).
 * Visual successor of the legacy `.card` class from apps/desktop — same
 * look, token-driven so it follows the light theme too. Use <section> via
 * `as` when the card is a landmark region with a heading.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card({ className, children, ...rest }, ref) {
  return (
    <div ref={ref} className={cn('ms-card', className)} {...rest}>
      {children}
    </div>
  );
});
