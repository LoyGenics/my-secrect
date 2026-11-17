import type { ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export interface TooltipProps {
  /** Tooltip text (plain string; keep it short — a phrase, not a paragraph). */
  content: string;
  children: ReactNode;
  /** Hover delay before showing, ms. Default 400 (Radix default 700 is sluggish for icon buttons). */
  delayDuration?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Tooltip on Radix Tooltip. The trigger keeps its own accessible name —
 * a tooltip is a supplement, never the only label (screen readers do not
 * reliably announce tooltips, and touch users cannot hover). Do not put
 * essential information only in a tooltip.
 */
export function Tooltip({ content, children, delayDuration = 400, side = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content side={side} sideOffset={6} className="ms-tooltip">
            {content}
            <RadixTooltip.Arrow style={{ fill: 'var(--ms-color-bg-raised)' }} />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
