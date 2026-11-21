import { useEffect, useRef, type RefObject } from 'react';
import { Button, IconButton } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

export interface FacetOption {
  key: string;
  label: string;
  count: number;
}

interface FilterPopoverProps {
  open: boolean;
  onClose: () => void;
  /** The Filter button: focus returns to it on close. */
  anchorRef: RefObject<HTMLButtonElement>;
  categories: FacetOption[];
  tags: FacetOption[];
  selectedCategories: ReadonlySet<string>;
  selectedTags: ReadonlySet<string>;
  onToggleCategory: (key: string) => void;
  onToggleTag: (tag: string) => void;
  onReset: () => void;
  shown: number;
  total: number;
}

/**
 * Non-modal filter popover beside the ledger: category and tag chips with
 * faceted counts, applied live. Esc or Done closes it and returns focus to
 * the Filter button; Reset clears every filter.
 */
export default function FilterPopover({
  open, onClose, anchorRef, categories, tags, selectedCategories, selectedTags, onToggleCategory, onToggleTag, onReset, shown, total,
}: FilterPopoverProps) {
  const { dict } = useTranslation();
  const sh = dict.shell;
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { onClose(); anchorRef.current?.focus(); };

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  if (!open) return null;
  const chip = (option: FacetOption, checked: boolean, onToggle: () => void) => (
    <button key={option.key} type="button" role="checkbox" aria-checked={checked} className="ms-facet" onClick={onToggle}>
      {option.label}
      <span className="ms-facet__count">{option.count}</span>
    </button>
  );
  return (
    <div
      ref={ref}
      className="ms-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="filter-title"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
    >
      <div className="ms-popover__head">
        <h2 id="filter-title">{sh.filterTitle}</h2>
        <IconButton icon="close" size="sm" label={dict.common.close} onClick={close} />
      </div>
      <div className="ms-popover__body">
        <section aria-labelledby="filter-types">
          <h3 id="filter-types">{sh.groups.types}</h3>
          <div className="ms-facets">
            {categories.map((c) => chip(c, selectedCategories.has(c.key), () => onToggleCategory(c.key)))}
          </div>
        </section>
        {tags.length > 0 && (
          <section aria-labelledby="filter-tags">
            <h3 id="filter-tags">{sh.groups.tags}</h3>
            <div className="ms-facets">
              {tags.map((t) => chip(t, selectedTags.has(t.key), () => onToggleTag(t.key)))}
            </div>
          </section>
        )}
      </div>
      <div className="ms-popover__foot">
        <span role="status">{format(sh.showing, shown, total)}</span>
        <Button size="sm" variant="ghost" onClick={onReset}>{sh.resetFilters}</Button>
        <Button size="sm" onClick={close}>{dict.common.done}</Button>
      </div>
    </div>
  );
}
