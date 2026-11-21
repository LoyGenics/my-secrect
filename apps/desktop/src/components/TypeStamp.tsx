import { Icon, isItemTypeKey, moduleIcon, typeStampFamily } from '../theme';

/**
 * Pocket Ledger type stamp: a round tint of the item's stamp family
 * (tokens `stamp.<family>`) with the type's glyph. Decorative: the type is
 * always named in text next to it.
 */
export default function TypeStamp({ type, size = 'md' }: { type: string; size?: 'sm' | 'md' | 'lg' }) {
  const known = isItemTypeKey(type);
  return (
    <span className={`ms-stamp ms-stamp--${size}`} data-family={known ? typeStampFamily[type] : 'note'} aria-hidden="true">
      <Icon name={known ? moduleIcon[type] : 'custom'} size={size === 'lg' ? 'xl' : size === 'sm' ? 'md' : 'lg'} />
    </span>
  );
}
