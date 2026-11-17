import { useState, type ReactNode } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../utils';

export interface TabDef {
  value: string;
  label: string;
  disabled?: boolean;
  content: ReactNode;
}

export interface TabsProps {
  tabs: TabDef[];
  /** Controlled value; omit for uncontrolled (defaults to first tab). */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Accessible name for the tab list when the tabs have no visible context. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Tabs on Radix Tabs: automatic arrow-key navigation (left/right/Home/End),
 * aria-selected / aria-controls / tabindex managed by Radix, activation on
 * focus (automatic) per WAI-ARIA tabs pattern.
 */
export function Tabs({ tabs, value, defaultValue, onValueChange, ariaLabel, className }: TabsProps) {
  return (
    <RadixTabs.Root
      value={value}
      defaultValue={defaultValue ?? tabs[0]?.value}
      onValueChange={onValueChange}
      className={className}
    >
      <RadixTabs.List className="ms-tabs__list" aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <RadixTabs.Trigger key={tab.value} value={tab.value} disabled={tab.disabled} className="ms-tabs__trigger">
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.value} value={tab.value} tabIndex={0}>
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * SegmentedControl: a single-select group (radiogroup pattern) for 2-4
 * mutually exclusive options (e.g. theme Light/Dark/System, density).
 * Arrow keys move between options, Space/Enter selects; the selected
 * option has aria-checked=true and tabindex=0, others tabindex=-1
 * (roving tabindex). Hand-rolled on purpose: Radix has no segmented
 * primitive, and this is 40 lines of honest ARIA rather than a dependency.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, disabled = false, className }: SegmentedControlProps<T>) {
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const move = (delta: number) => {
    let next = focusIndex;
    for (let i = 0; i < options.length; i++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setFocusIndex(next);
    const el = document.querySelector<HTMLElement>(`[data-segmented-option="${options[next].value}"]`);
    el?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('ms-segmented', className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-segmented-option={option.value}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.disabled}
            className="ms-segmented__option"
            onClick={() => {
              setFocusIndex(index);
              onChange(option.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
              else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(option.value); }
            }}
            onFocus={() => setFocusIndex(index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
