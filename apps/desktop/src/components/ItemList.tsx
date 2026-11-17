import type { VaultItem } from '../../../../packages/core/src/types';
import { isFavorite } from '../utils/password';
import { isArchived } from '../utils/itemMeta';

interface ItemListProps {
  items: VaultItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  /** Bulk-selection mode (driven by App.tsx): rows get checkboxes and a tap toggles selection instead of opening the item. */
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

export default function ItemList({ items, selectedId, onSelect, onToggleFavorite, onDelete, selectionMode = false, selectedIds, onToggleSelect }: ItemListProps) {
  if (items.length === 0) {
    return (
      <div>
        <p>No items yet.</p>
        <p>Create your first item to get started.</p>
      </div>
    );
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item) => {
        const favorite = isFavorite(item);
        const subtitle = itemSubtitle(item);
        const checked = selectedIds?.has(item.id) ?? false;
        return (
          <li
            key={item.id}
            onClick={() => {
              if (selectionMode && onToggleSelect) onToggleSelect(item.id);
              else onSelect(item.id);
            }}
            style={{
              cursor: 'pointer',
              padding: '8px 10px',
              borderBottom: '1px solid #eee',
              background: checked ? '#eef4ff' : item.id === selectedId ? '#eef4ff' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {selectionMode && (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelect?.(item.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${item.title}`}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  <strong>{item.title}</strong>{' '}
                  <small style={{ color: '#666' }}>({item.type})</small>
                  {isArchived(item) && <small style={{ color: '#666' }}> 📦 Archived</small>}
                </div>
                {subtitle && (
                  <div style={{ color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {subtitle}
                  </div>
                )}
                {item.tags.length > 0 && (
                  <div style={{ marginTop: 2 }}>
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          display: 'inline-block',
                          background: '#f0f0f0',
                          borderRadius: 10,
                          padding: '0 8px',
                          marginRight: 4,
                          fontSize: 12,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
                title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(item.id);
                }}
              >
                {favorite ? '★' : '☆'}
              </button>
              <button
                type="button"
                aria-label={`Delete ${item.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.id);
                }}
              >
                Delete
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
