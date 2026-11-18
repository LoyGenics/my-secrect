import { useId, type ReactNode } from 'react';
import type { ItemType } from '../../../../packages/core/src/types';
import { Button, Icon, Led, Readout, TypeModule, brandMark, categoryModule, cn, type IconName } from '../theme';
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
  /** Vault health score 0–100 shown next to the health entry. */
  healthScore?: number;
  onLock: () => void;
  onExport: () => void;
  onImport: () => void;
  onShowRecovery: () => void;
  /** Rendered inside the phone navigation drawer: labels always visible. */
  inDrawer?: boolean;
}

interface NavItemProps {
  current: boolean;
  label: string;
  onClick: () => void;
  glyph: ReactNode;
  count?: number;
  trailing?: ReactNode;
  tone?: 'danger';
}

function NavItem({ current, label, onClick, glyph, count, trailing, tone }: NavItemProps) {
  return (
    <button
      type="button"
      className={cn('ms-nav-item', tone === 'danger' && 'ms-nav-item--danger')}
      aria-current={current ? 'page' : undefined}
      title={label}
      onClick={onClick}
    >
      <span className="ms-nav-item__glyph" aria-hidden="true">{glyph}</span>
      <span className="ms-nav-item__label">{label}</span>
      {trailing}
      {count !== undefined && count > 0 && <Readout value={count} />}
    </button>
  );
}

const icon = (name: IconName) => <Icon name={name} />;

/**
 * The sidebar: views, category swatches with counts, the health score,
 * tags and the Lock button. Every entry is a real <button> with
 * aria-current on the active view. Tablet collapses it to icons (labels
 * stay as accessible names); phones host it in the navigation drawer.
 */
export default function Sidebar({
  view,
  setView,
  counts,
  tags,
  healthScore,
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
  const healthTone = healthScore === undefined ? undefined : healthScore >= 80 ? 'ok' : healthScore >= 50 ? 'attention' : 'danger';
  return (
    <nav className={cn('ms-rail', inDrawer && 'ms-rail--drawer')} aria-label={s.navLabel}>
      <div className="ms-rail__brand">
        {brandMark.src ? (
          <img src={brandMark.src} alt="" width={34} height={34} />
        ) : (
          <span className="ms-brand-mark" aria-hidden="true">{dict.common.appName.charAt(0)}</span>
        )}
        <span className="ms-rail__brand-text">
          <span className="ms-heading ms-heading--md block">{dict.common.appName}</span>
          <span className="ms-text-sm ms-text-muted block">{s.tagline}</span>
        </span>
      </div>

      <div className="ms-rail__scroll">
        <div className="ms-rail__group" role="group" aria-labelledby={groupId('vaults')}>
          <span id={groupId('vaults')} className="ms-rail__group-title ms-legend">{s.groups.vaults}</span>
          <NavItem current={is('all')} label={s.allItems} glyph={icon('items')} count={counts.all} onClick={() => setView('all')} />
          <NavItem current={is('favorites')} label={s.favorites} glyph={icon('favorite')} count={counts.favorites} onClick={() => setView('favorites')} />
          <NavItem current={is('archived')} label={s.archived} glyph={icon('archive')} count={counts.archived} onClick={() => setView('archived')} />
          <NavItem current={is('trash')} label={s.trash} glyph={icon('trash')} count={counts.trash} onClick={() => setView('trash')} />
        </div>

        <div className="ms-rail__group" role="group" aria-labelledby={groupId('categories')}>
          <span id={groupId('categories')} className="ms-rail__group-title ms-legend">{s.groups.categories}</span>
          {CATEGORIES.map((c) => (
            <NavItem
              key={c.key}
              current={is(c.key)}
              label={dict.categories[c.key]}
              glyph={<TypeModule type={categoryModule[c.key]} size="sm" />}
              count={counts.categories[c.key] ?? 0}
              onClick={() => setView(c.key)}
            />
          ))}
        </div>

        <div className="ms-rail__group" role="group" aria-labelledby={groupId('tools')}>
          <span id={groupId('tools')} className="ms-rail__group-title ms-legend">{s.groups.tools}</span>
          <NavItem
            current={is('health')}
            label={s.watchtower}
            glyph={icon('health')}
            trailing={
              healthScore !== undefined ? (
                <span className="flex items-center gap-1.5">
                  <Led tone={healthTone} />
                  <Readout value={healthScore} />
                </span>
              ) : undefined
            }
            onClick={() => setView('health')}
          />
          <NavItem current={is('generator')} label={s.generator} glyph={icon('generate')} onClick={() => setView('generator')} />
        </div>

        <div className="ms-rail__group" role="group" aria-labelledby={groupId('library')}>
          <span id={groupId('library')} className="ms-rail__group-title ms-legend">{s.groups.library}</span>
          <NavItem current={is('media-gallery')} label={s.mediaGallery} glyph={icon('gallery')} onClick={() => setView('media-gallery')} />
          <NavItem current={is('shares')} label={s.sharing} glyph={icon('share')} onClick={() => setView('shares')} />
        </div>

        <div className="ms-rail__group" role="group" aria-labelledby={groupId('app')}>
          <span id={groupId('app')} className="ms-rail__group-title ms-legend">{s.groups.app}</span>
          <NavItem current={is('settings')} label={s.settings} glyph={icon('settings')} onClick={() => setView('settings')} />
          <NavItem current={is('security')} label={s.securityCenter} glyph={icon('security')} onClick={() => setView('security')} />
          <NavItem current={false} label={s.exportBackup} glyph={icon('export')} onClick={onExport} />
          <NavItem current={false} label={s.importBackup} glyph={icon('import')} onClick={onImport} />
          <NavItem current={false} label={s.recoveryKey} glyph={icon('recovery')} onClick={onShowRecovery} />
        </div>

        {tags.length > 0 && (
          <div className="ms-rail__group ms-rail__tags" role="group" aria-labelledby={groupId('tags')}>
            <span id={groupId('tags')} className="ms-rail__group-title ms-legend">{s.groups.tags}</span>
            <div className="ms-tag-list">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="ms-tag"
                  aria-current={view === `tag:${tag}` ? 'page' : undefined}
                  onClick={() => setView(`tag:${tag}`)}
                >
                  <Icon name="tag" size="xs" />
                  {tag}
                  {counts.tags[tag] ? <span className="ms-text-muted">{counts.tags[tag]}</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ms-rail__foot">
        <Button variant="secondary" block icon="lock" onClick={onLock} title={s.lockVault}>
          <span className="ms-button__text">{s.lockVault}</span>
        </Button>
      </div>
    </nav>
  );
}
