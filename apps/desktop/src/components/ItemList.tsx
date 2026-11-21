import type { VaultItem } from '../../../../packages/core/src/types';
import { cardIssuer, cardLast4 } from '../../../../packages/core/src/card';
import { isFavorite } from '../utils/password';
import { isArchived } from '../utils/itemMeta';
import { Icon, IconButton, copyWithClear, useClipboardStatus } from '../theme';
import TypeStamp from './TypeStamp';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

interface ItemListProps {
  items: VaultItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Title A–Z: print the first letter of each new letter group in the margin. */
  letters?: boolean;
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

/** The title the ledger prints (cards show their issuer); Title A–Z sorts by it. */
export function itemDisplayTitle(item: VaultItem): string {
  return item.type === 'card' ? cardIssuer(item.title, item.fields.bank) : item.title;
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
      const last4 = cardLast4(item.fields);
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

/** The field a row's quick-copy button copies (logins and cards only), with its label key. */
function quickCopyField(item: VaultItem): { key: string; label: 'copyPassword' | 'copyCardNumber' } | null {
  if (item.type === 'login' && fieldString(item, 'password')) return { key: 'password', label: 'copyPassword' };
  if (item.type === 'card' && fieldString(item, 'card_number')) return { key: 'card_number', label: 'copyCardNumber' };
  return null;
}

/**
 * The ledger: A–Z margin letters (when sorted by title), the type stamp, the
 * title (+ star for favorites) and one subtitle line. Logins and cards carry
 * a quick-copy button (password / card number) that uses the same
 * clear-after-30s clipboard as the detail page. The row's main area is a
 * real button, so the list is fully keyboard operable.
 */
export default function ItemList({ items, selectedId, onSelect, letters = false, selectionMode = false, selectedIds, onToggleSelect }: ItemListProps) {
  const { dict } = useTranslation();
  const l = dict.itemList;
  const { copiedKey } = useClipboardStatus();
  let lastLetter = '';
  return (
    <ul className="ms-list" aria-label={l.label} data-letters={letters}>
      {items.map((item) => {
        const favorite = isFavorite(item);
        const title = itemDisplayTitle(item);
        const subtitle = itemSubtitle(item) || ((dict.itemTypes as Record<string, string>)[item.type] ?? item.type);
        const checked = selectedIds?.has(item.id) ?? false;
        const selected = selectionMode ? checked : item.id === selectedId;
        const letter = title.charAt(0).toLocaleUpperCase();
        const margin = letters && letter !== lastLetter ? letter : '';
        lastLetter = letter;
        const quick = selectionMode ? null : quickCopyField(item);
        const quickKey = quick ? `${item.id}:field:${quick.key}` : '';
        return (
          <li key={item.id} className="ms-row" data-selected={selected}>
            {selectionMode && (
              <span className="ms-checkbox ms-row__check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelect?.(item.id)}
                  aria-label={format(l.select, title)}
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
              {letters && <span className="ms-row__letter" aria-hidden="true">{margin}</span>}
              <TypeStamp type={item.type} />
              <span className="ms-row__text">
                <span className="ms-row__title">
                  <span>{title}</span>
                  {favorite && <Icon name="favorite" size="md" className="ms-row__star" label={l.favorite} />}
                </span>
                <span className="ms-row__meta">
                  {subtitle}
                  {isArchived(item) ? ` · ${l.archived}` : ''}
                </span>
              </span>
            </button>
            {quick && (
              <IconButton
                icon={copiedKey === quickKey ? 'check' : 'copy'}
                size="sm"
                variant="ghost"
                className="ms-row__copy"
                data-done={copiedKey === quickKey}
                label={format(l[quick.label], title)}
                onClick={() => void copyWithClear(quickKey, fieldString(item, quick.key))}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
