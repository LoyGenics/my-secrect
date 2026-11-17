import { useMemo } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import { CommandPalette, TypeModule, type CommandItem } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

export interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  items: VaultItem[];
  onSelect: (item: VaultItem) => void;
}

/** Text the palette matches besides the title: tags, type and string field values (same as before). */
function searchableText(item: VaultItem): string {
  const fieldText = Object.values(item.fields ?? {})
    .flatMap((v) => (typeof v === 'string' ? [v] : []))
    .join(' ');
  return `${(item.tags ?? []).join(' ')} ${item.type} ${fieldText}`;
}

/**
 * Vault search (Cmd/Ctrl+K) on the design system's CommandPalette: focus
 * trap, Escape, focus return, combobox + listbox. Matches title, tags, type
 * and field values; shows at most 20 results; each row carries its type
 * module and localized type.
 */
export default function SearchPalette({ open, onClose, items, onSelect }: SearchPaletteProps) {
  const { dict } = useTranslation();
  const commands = useMemo<CommandItem[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        label: item.title,
        keywords: searchableText(item),
        leading: <TypeModule type={item.type} size="sm" />,
        meta: (dict.itemTypes as Record<string, string>)[item.type] ?? item.type,
        onSelect: () => onSelect(item),
      })),
    [items, onSelect, dict],
  );
  return (
    <CommandPalette
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      items={commands}
      limit={20}
      title={dict.search.title}
      placeholder={dict.search.placeholder}
      emptyLabel={(query) => format(dict.search.noMatch, query)}
    />
  );
}
