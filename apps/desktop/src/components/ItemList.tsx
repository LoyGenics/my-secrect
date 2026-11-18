import type { VaultItem } from '../../../../packages/core/src/types';
import { isFavorite } from '../utils/password';
import { isArchived } from '../utils/itemMeta';
import { Badge, IconButton, TypeModule } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

interface ItemListProps {
  items: VaultItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  /** Bulk-selection mode (driven by App.tsx): rows get checkboxes and activating a row toggles selection instead of opening the item. */
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}

function fieldString(item: VaultItem, key: string): string {
  const v = item.fields?.[key];
  return typeof v === 'string' ? v : '';
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Short identifying subtitle per item type, from its fields. */
export function itemSubtitle(item: VaultItem): string {
  switch (item.type) {
    case 'login':
      return fieldString(item, 'username') || fieldString(item, 'url');
    case 'passkey':
      return fieldString(item, 'rp_id');
    case 'bank_account':
      return fieldString(item, 'bank_name') || fieldString(item, 'holder_name');
    case 'card': {
      const brand = fieldString(item, 'brand');
      const last4 = fieldString(item, 'last4');
      return [brand, last4 ? `•••• ${last4}` : ''].filter(Boolean).join(' ');
    }
    case 'identity':
      return fieldString(item, 'full_name');
    case 'ssh_key':
      return fieldString(item, 'comment');
    case 'api_key':
      return fieldString(item, 'service');
    case 'secure_note':
      return truncate(fieldString(item, 'body'));
    case 'document':
    case 'media':
      return fieldString(item, 'file_name');
    case 'collection':
      return fieldString(item, 'url') || truncate(fieldString(item, 'description'));
    case 'custom':
      return truncate(fieldString(item, 'notes'));
    default:
      return '';
  }
}

/**
 * Item rows: the type's pastel tile, title, one secondary line, tags;
 * favorite and delete buttons appear on hover/focus (always on touch). The
 * row's main area is a real button, so the list is fully keyboard operable.
 * The selected row is tinted with the soft brand colour.
 */
export default function ItemList({ items, selectedId, onSelect, onToggleFavorite, onDelete, selectionMode = false, selectedIds, onToggleSelect }: ItemListProps) {
  const { dict } = useTranslation();
  const l = dict.itemList;
  return (
    <ul className="ms-list" aria-label={l.label}>
      {items.map((item) => {
        const favorite = isFavorite(item);
        const subtitle = itemSubtitle(item);
        const checked = selectedIds?.has(item.id) ?? false;
        const selected = selectionMode ? checked : item.id === selectedId;
        const typeLabel = (dict.itemTypes as Record<string, string>)[item.type] ?? item.type;
        return (
          <li key={item.id} className="ms-row" data-selected={selected}>
            {selectionMode && (
              <span className="ms-checkbox ms-row__check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelect?.(item.id)}
                  aria-label={format(l.select, item.title)}
                />
              </span>
            )}
            <button
              type="button"
              className="ms-row__main"
              aria-current={!selectionMode && item.id === selectedId ? 'true' : undefined}
              onClick={() => {
                if (selectionMode && onToggleSelect) onToggleSelect(item.id);
                else onSelect(item.id);
              }}
            >
              <TypeModule type={item.type} />
              <span className="ms-row__text">
                <span className="ms-row__title">{item.title}</span>
                <span className="ms-row__meta">
                  {typeLabel}
                  {subtitle ? ` · ${subtitle}` : ''}
                  {isArchived(item) ? ` · ${l.archived}` : ''}
                </span>
                {item.tags.length > 0 && (
                  <span className="ms-row__tags">
                    {item.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </span>
                )}
              </span>
            </button>
            <span className="ms-row__actions" data-pinned={favorite}>
              <IconButton
                icon="favorite"
                size="sm"
                label={favorite ? l.removeFavorite : l.addFavorite}
                aria-pressed={favorite}
                className={favorite ? 'ms-favorite--on' : undefined}
                onClick={() => onToggleFavorite(item.id)}
              />
              <IconButton icon="trash" size="sm" label={format(l.delete, item.title)} onClick={() => onDelete(item.id)} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
