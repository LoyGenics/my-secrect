import type { ArtSource } from '../illustrations';
import { cn } from '../utils';

export interface ArtProps {
  src: ArtSource;
  /** Rendered box in px (square). */
  size: number;
  className?: string;
  /** Eager-load above-the-fold heroes; everything else is lazy. */
  eager?: boolean;
}

/**
 * Decorative illustration (alt=""). Animated clips swap to their still
 * first frame under prefers-reduced-motion via <picture>, so no motion
 * plays for users who asked for none.
 */
export function Art({ src, size, className, eager = false }: ArtProps) {
  const img = (url: string) => (
    <img
      className={cn('ms-art', className)}
      src={url}
      alt=""
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
  if (typeof src === 'string') return img(src);
  return (
    <picture>
      <source srcSet={src.still} media="(prefers-reduced-motion: reduce)" />
      {img(src.animated)}
    </picture>
  );
}
