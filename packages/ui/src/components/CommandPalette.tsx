import { useEffect, useMemo, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Locale } from '@my-secrect/i18n';
import { cn } from '../utils';
import { useUiStrings } from '../useUiStrings';

export interface CommandItem {
  id: string;
  label: string;
  /** Optional hint shown right-aligned (e.g. a shortcut). */
  hint?: string;
  /** Group heading (e.g. 'Actions', 'Items'). Items keep insertion order within a group. */
  group?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  /** Called with the query on every keystroke (parent filters or passes all items; default filters by label). */
  onQueryChange?: (query: string) => void;
  locale?: Locale;
  placeholder?: string;
  emptyLabel?: string;
}

/**
 * Command palette (Cmd+K / Ctrl+K). Hand-rolled on Radix Dialog for the
 * focus trap + Escape handling, with a listbox pattern inside:
 * ArrowUp/Down moves the active option (aria-activedescendant),
 * Enter runs it, Escape closes. The input has role="combobox" with
 * aria-expanded / aria-controls / aria-activedescendant.
 *
 * Why no `cmdk` dependency: the palette is a filtered list over Dialog —
 * one file of explicit ARIA instead of a second overlay library whose
 * keyboard model we would still have to audit. The desktop app's existing
 * SearchPalette can be re-implemented on this component.
 *
 * Mounting the global hotkey is the app's job (see `useCommandPaletteHotkey`
 * below) so the palette itself stays a pure controlled component.
 */
export function CommandPalette({ open, onOpenChange, items, onQueryChange, locale, placeholder, emptyLabel }: CommandPaletteProps) {
  const strings = useUiStrings({ locale });
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q) || (item.group ?? '').toLowerCase().includes(q));
  }, [items, query]);
  const enabled = useMemo(() => filtered.filter((i) => !i.disabled), [filtered]);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveId(null);
    }
  }, [open ]);
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
    document.getElementById(`ms-cmd-${next.id}`)?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ms-dialog-overlay" />
        <RadixDialog.Content
          className={cn('ms-dialog', 'ms-command-palette')}
          onOpenAutoFocus={(e) => {
            // Focus the search input, not the dialog body.
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <RadixDialog.Title className="ms-dialog__title" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {strings.commandPalette.close}
          </RadixDialog.Title>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-controls="ms-command-listbox"
            aria-activedescendant={activeId ? `ms-cmd-${activeId}` : undefined}
            aria-label={placeholder ?? strings.commandPalette.placeholder}
            className="ms-input"
            placeholder={placeholder ?? strings.commandPalette.placeholder}
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
          <ul id="ms-command-listbox" role="listbox" aria-label={strings.commandPalette.placeholder} className="ms-command-palette__list">
            {filtered.map((item) => (
              <li key={item.id} role="option" id={`ms-cmd-${item.id}`} aria-selected={activeId === item.id} aria-disabled={item.disabled || undefined}>
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={item.disabled}
                  className="ms-command-palette__item"
                  onMouseEnter={() => setActiveId(item.id)}
                  onClick={() => run(item)}
                >
                  <span>{item.label}</span>
                  {item.hint && <span className="ms-command-palette__item-kbd">{item.hint}</span>}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="ms-state" role="status">
                <p className="ms-state__body">{emptyLabel ?? strings.commandPalette.noResults}</p>
              </li>
            )}
          </ul>
          <p className="ms-command-palette__hint">{strings.commandPalette.hint}</p>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * Global Cmd+K / Ctrl+K hotkey. Returns nothing; call in the app root:
 *   useCommandPaletteHotkey(() => setPaletteOpen((v) => !v));
 * Ignored while the user types in an input/textarea/select (the palette
 * input itself is outside those elements when closed).
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
