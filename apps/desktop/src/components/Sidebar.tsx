import { useId, type ReactNode } from 'react';
import type { ItemType } from '../../../../packages/core/src/types';
import { Icon, Readout, categoryModule, cn, type IconName } from '../theme';
import TypeStamp from './TypeStamp';
import { useTranslation } from '../../../../packages/i18n/src/react';

export type CategoryKey =
  | 'credentials'
  | 'finance'
  | 'identity'
  | 'developer'
  | 'notes'
  | 'media'
  | 'documents'
  | 'collections';

export type SidebarView =
  | 'all'
  | 'favorites'
  | 'trash'
  | 'archived'
  | 'health'
  | 'generator'
  | 'settings'
  | 'security'
  | 'media-gallery'
  | 'shares'
  | CategoryKey
  | `tag:${string}`;

export interface CategoryDef {
  key: CategoryKey;
  /** English fallback; the UI shows `dict.categories[key]`. */
  label: string;
  types: ItemType[];
}

export const CATEGORIES: CategoryDef[] = [
  { key: 'credentials', label: 'Credentials', types: ['login', 'passkey'] },
  { key: 'finance', label: 'Finance', types: ['bank_account', 'card'] },
  { key: 'identity', label: 'Identity', types: ['identity'] },
  { key: 'developer', label: 'Developer', types: ['ssh_key', 'api_key'] },
  { key: 'notes', label: 'Secure Notes', types: ['secure_note'] },
  { key: 'media', label: 'Private Media', types: ['media'] },
  { key: 'documents', label: 'Documents', types: ['document'] },
  { key: 'collections', label: 'Collections', types: ['collection', 'custom'] },
];

export function categoryForType(type: ItemType): CategoryKey {
  return CATEGORIES.find((c) => c.types.includes(type))?.key ?? 'collections';
}

export interface SidebarCounts {
  all: number;
  favorites: number;
  trash: number;
  archived: number;
  health: number;
  categories: Record<CategoryKey, number>;
  tags: Record<string, number>;
}

export function emptyCounts(): SidebarCounts {
  return {
    all: 0,
    favorites: 0,
    trash: 0,
    archived: 0,
    health: 0,
    categories: {
      credentials: 0,
      finance: 0,
      identity: 0,
      developer: 0,
      notes: 0,
      media: 0,
      documents: 0,
      collections: 0,
    },
    tags: {},
  };
}

export interface SidebarProps {
  view: SidebarView;
  setView: (view: SidebarView) => void;
  counts: SidebarCounts;
  tags: string[];
  /** Sync status line above Lock (omitted when sync is off). */
  syncLabel?: string;
  onLock: () => void;
  onExport: () => void;
  onImport: () => void;
  onShowRecovery: () => void;
  /** Rendered inside the navigation drawer (< 1100 px). */
  inDrawer?: boolean;
}

/** Views that belong to the Settings tab: the spine shows the settings index for them. */
export const SETTINGS_VIEWS: SidebarView[] = ['settings', 'security', 'shares'];

interface NavItemProps {
  current: boolean;
  label: string;
  onClick: () => void;
  glyph: ReactNode;
  count?: number;
}

function NavItem({ current, label, onClick, glyph, count }: NavItemProps) {
  return (
    <button type="button" className="ms-nav-item" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <span className="ms-nav-item__glyph" aria-hidden="true">{glyph}</span>
      <span className="ms-nav-item__label">{label}</span>
      {count !== undefined && count > 0 && <Readout value={count} />}
    </button>
  );
}

const icon = (name: IconName) => <Icon name={name} size="md" />;

/**
 * The spine: the index of the current dock tab, on the cover colour.
 * Vault tab: scopes, the eight categories (each with its family stamp and a
 * count) and tags. Settings tab: the settings sections and the backup /
 * recovery actions. The footer carries the sync line and Lock vault. Every
 * entry is a real <button> with aria-current on the active view; below
 * 1100 px the spine lives in the navigation drawer.
 */
export default function Sidebar({
  view,
  setView,
  counts,
  tags,
  syncLabel,
  onLock,
  onExport,
  onImport,
  onShowRecovery,
  inDrawer = false,
}: SidebarProps) {
  const { dict } = useTranslation();
  const s = dict.shell;
  const uid = useId();
  const groupId = (name: string) => `${uid}-${name}`;
  const is = (v: SidebarView) => view === v;
  const group = (name: string, title: string | null, children: ReactNode) => (
    <div className="ms-rail__group" role="group" aria-labelledby={title ? groupId(name) : undefined} aria-label={title ? undefined : s.groups.vaults}>
      {title && <span id={groupId(name)} className="ms-rail__group-title">{title}</span>}
      {children}
    </div>
  );
  return (
    <nav className={cn('ms-rail', inDrawer && 'ms-rail--drawer')} aria-label={s.navLabel}>
      <div className="ms-rail__scroll">
        {SETTINGS_VIEWS.includes(view) ? (
          <>
            {group('preferences', s.groups.preferences, (
              <NavItem current={is('settings')} label={s.general} glyph={icon('settings')} onClick={() => setView('settings')} />
            ))}
            {group('security', s.groups.security, (
              <>
                <NavItem current={is('security')} label={s.securityCenter} glyph={icon('shield')} onClick={() => setView('security')} />
                <NavItem current={false} label={s.recoveryKey} glyph={icon('recovery')} onClick={onShowRecovery} />
              </>
            ))}
            {group('data', s.groups.data, (
              <>
                <NavItem current={false} label={s.exportBackup} glyph={icon('export')} onClick={onExport} />
                <NavItem current={false} label={s.importBackup} glyph={icon('import')} onClick={onImport} />
              </>
            ))}
            {group('account', s.groups.account, (
              <NavItem current={is('shares')} label={s.sharing} glyph={icon('share')} onClick={() => setView('shares')} />
            ))}
          </>
        ) : (
          <>
            {group('vaults', null, (
              <>
                <NavItem current={is('all')} label={s.allItems} glyph={icon('items')} count={counts.all} onClick={() => setView('all')} />
                <NavItem current={is('favorites')} label={s.favorites} glyph={icon('favorite')} count={counts.favorites} onClick={() => setView('favorites')} />
                <NavItem current={is('archived')} label={s.archived} glyph={icon('archive')} count={counts.archived} onClick={() => setView('archived')} />
                <NavItem current={is('trash')} label={s.trash} glyph={icon('trash')} count={counts.trash} onClick={() => setView('trash')} />
              </>
            ))}
            {group('types', s.groups.types, CATEGORIES.map((c) => (
              <NavItem
                key={c.key}
                current={is(c.key)}
                label={dict.categories[c.key]}
                glyph={<TypeStamp type={categoryModule[c.key]} size="sm" />}
                count={counts.categories[c.key] ?? 0}
                onClick={() => setView(c.key)}
              />
            )))}
            {tags.length > 0 && group('tags', s.groups.tags, (
              <div className="ms-tag-list">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="ms-tag"
                    aria-current={view === `tag:${tag}` ? 'page' : undefined}
                    onClick={() => setView(`tag:${tag}`)}
                  >
                    #{tag}
                    {counts.tags[tag] ? <span className="ms-tag__count">{counts.tags[tag]}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="ms-rail__foot">
        {syncLabel && <span className="ms-rail__sync">{syncLabel}</span>}
        <button type="button" className="ms-rail__lock" onClick={onLock}>
          <Icon name="lock" size="md" />
          <span>{s.lockVault}</span>
        </button>
      </div>
    </nav>
  );
}
