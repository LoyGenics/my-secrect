import type { ReactNode } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '../utils';

export interface MenuItemDef {
  key: string;
  label: string;
  /** Optional keyboard shortcut text shown right-aligned (e.g. 'Ctrl+K'). */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface DropdownMenuProps {
  /** The trigger element (usually a Button with aria-haspopup handled by Radix). */
  trigger: ReactNode;
  items: MenuItemDef[];
  /** Optional label shown at the top of the menu. */
  label?: string;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/**
 * Dropdown menu on Radix DropdownMenu: arrow-key navigation, typeahead,
 * Escape to close with focus return, roving tabindex handled by Radix.
 * Items are plain data (`MenuItemDef[]`) so menus stay declarative and
 * localizable — pass already-translated labels in.
 */
export function DropdownMenu({ trigger, items, label, align = 'end', className }: DropdownMenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content align={align} sideOffset={6} className={cn('ms-menu', className)}>
          {label && <RadixMenu.Label className="ms-menu__label">{label}</RadixMenu.Label>}
          {items.map((item) => (
            <RadixMenu.Item
              key={item.key}
              disabled={item.disabled}
              // Radix closes the menu after onSelect fires. Do NOT call
              // preventDefault() here — it would keep the menu open.
              onSelect={() => item.onSelect()}
              className={cn('ms-menu__item', item.danger && 'ms-menu__item--danger')}
            >
              <span>{item.label}</span>
              {item.shortcut && <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{item.shortcut}</span>}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export { RadixMenu as MenuPrimitives };
