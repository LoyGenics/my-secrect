import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';
import { Icon } from './Icon';
import { Kbd } from './Instrument';

export interface CommandItem {
  id: string;
  label: string;
  /** Extra text matched by the filter but not shown (tags, field values, type). */
  keywords?: string;
  /** Leading visual (e.g. a TypeModule). Decorative. */
  leading?: ReactNode;
  /** Trailing muted text (e.g. the localized type). */
  meta?: string;
  /** Group heading (e.g. 'Actions', 'Items'). Items keep insertion order within a group. */
  group?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  /** Accessible dialog title (visually hidden). */
  title?: string;
  /** Called with the query on every keystroke. Filtering stays internal (label + group + keywords). */
  onQueryChange?: (query: string) => void;
  /** Show at most this many results. */
  limit?: number;
  locale?: Locale;
  placeholder?: string;
  /** Empty message; a function receives the current query. */
  emptyLabel?: string | ((query: string) => string);
  /** Where focus goes when the palette closes (e.g. the search field that opened it). Default: Radix's focus return. */
  returnFocusRef?: RefObject<HTMLElement>;
}

/**
 * Command palette (Cmd/Ctrl+K): a top-anchored plate on Radix Dialog (focus
 * trap, Escape, focus return) with a combobox + listbox inside. ArrowUp/Down
 * move the active option (aria-activedescendant), Enter runs it. Mounting
 * the hotkey is the app's job (`useCommandPaletteHotkey`).
 */
export function CommandPalette({ open, onOpenChange, items, title, onQueryChange, limit, locale, placeholder, emptyLabel, returnFocusRef }: CommandPaletteProps) {
  const strings = useUiStrings({ locale });
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (id: string) => `${listId}-${id}`;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? items.filter((item) => `${item.label} ${item.group ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(q))
      : items;
    return limit ? matches.slice(0, limit) : matches;
  }, [items, query, limit]);
  const enabled = useMemo(() => filtered.filter((i) => !i.disabled), [filtered]);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveId(null);
    }
  }, [open]);
  useEffect(() => {
    setActiveId(enabled[0]?.id ?? null);
  }, [query, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (item: CommandItem) => {
    if (item.disabled) return;
    onOpenChange(false);
    item.onSelect();
  };
  const move = (delta: number) => {
    if (enabled.length === 0) return;
    const idx = enabled.findIndex((i) => i.id === activeId);
    const next = enabled[(idx + delta + enabled.length) % enabled.length];
    setActiveId(next.id);
    document.getElementById(optionId(next.id))?.scrollIntoView({ block: 'nearest' });
  };
  const empty = typeof emptyLabel === 'function' ? emptyLabel(query) : emptyLabel ?? strings.commandPalette.noResults;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ms-dialog-overlay" />
        <RadixDialog.Content
          className={cn('ms-dialog', 'ms-command-palette')}
          onCloseAutoFocus={(e) => {
            if (!returnFocusRef?.current) return;
            e.preventDefault();
            returnFocusRef.current.focus();
          }}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <RadixDialog.Title className="ms-sr-only">{title ?? strings.commandPalette.title}</RadixDialog.Title>
          <span className="ms-input-wrap ms-search-field">
            <span className="ms-search-field__icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId ? optionId(activeId) : undefined}
              aria-label={placeholder ?? strings.commandPalette.placeholder}
              className="ms-input"
              placeholder={placeholder ?? strings.commandPalette.placeholder}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                onQueryChange?.(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
                else if (e.key === 'Enter') {
                  e.preventDefault();
                  const item = enabled.find((i) => i.id === activeId) ?? enabled[0];
                  if (item) run(item);
                }
              }}
            />
          </span>
          <ul id={listId} role="listbox" aria-label={placeholder ?? strings.commandPalette.placeholder} className="ms-command-palette__list">
            {filtered.map((item) => (
              <li
                key={item.id}
                role="option"
                id={optionId(item.id)}
                aria-selected={activeId === item.id}
                aria-disabled={item.disabled || undefined}
                className="ms-command-palette__item"
                onMouseEnter={() => setActiveId(item.id)}
                onClick={() => run(item)}
              >
                {item.leading}
                <span className="ms-command-palette__label">{item.label}</span>
                {item.meta && <span className="ms-legend">{item.meta}</span>}
              </li>
            ))}
          </ul>
          {filtered.length === 0 && (
            <p className="ms-command-palette__empty" role="status">
              {empty}
            </p>
          )}
          <p className="ms-command-palette__hint ms-legend" aria-hidden="true">
            <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> {strings.commandPalette.move}</span>
            <span><Kbd>↵</Kbd> {strings.commandPalette.open}</span>
            <span><Kbd>Esc</Kbd> {strings.commandPalette.dismiss}</span>
          </p>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * Global Cmd+K / Ctrl+K hotkey. Call once in the app root:
 *   useCommandPaletteHotkey(() => setPaletteOpen((v) => !v));
 * Ignored while typing in an input/textarea/select.
 */
export function useCommandPaletteHotkey(onToggle: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'k') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      e.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggle]);
}
