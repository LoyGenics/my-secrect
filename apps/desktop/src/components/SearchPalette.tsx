import { useEffect, useMemo, useRef, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';

export interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  items: VaultItem[];
  onSelect: (item: VaultItem) => void;
}

function searchableText(item: VaultItem): string {
  const fieldText = Object.values(item.fields ?? {})
    .flatMap((v) => (typeof v === 'string' ? [v] : []))
    .join(' ');
  return `${item.title} ${(item.tags ?? []).join(' ')} ${item.type} ${fieldText}`.toLowerCase();
}

export default function SearchPalette({ open, onClose, items, onSelect }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 20);
    return items.filter((i) => searchableText(i).includes(q)).slice(0, 20);
  }, [query, items]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after mount so typing goes straight into the palette.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open ]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const choose = (item: VaultItem) => {
    onSelect(item);
    onClose();
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[active];
      if (item) choose(item);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-lg overflow-hidden" role="dialog" aria-label="Search vault">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <span className="text-zinc-400">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search items, tags, fields…"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            aria-label="Search vault"
          />
          <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-400">ESC</kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">
              No items match “{query}”.
            </p>
          )}
          {results.map((item, idx) => (
            <button
              key={item.id}
              onMouseEnter={() => setActive(idx)}
              onClick={() => choose(item)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${
                idx === active ? 'bg-indigo-600/20 text-indigo-100' : 'text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <span className="truncate">{item.title}</span>
              <span className="ml-3 shrink-0 text-xs text-zinc-500">{item.type}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          ↑↓ to navigate · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}
