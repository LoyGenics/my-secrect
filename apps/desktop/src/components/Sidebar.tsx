import type { ItemType } from '../../../../packages/core/src/types';

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
  | 'settings'
  | 'media-gallery'
  | 'shares'
  | CategoryKey
  | `tag:${string}`;

export interface CategoryDef {
  key: CategoryKey;
  label: string;
  glyph: string;
  types: ItemType[];
}

export const CATEGORIES: CategoryDef[] = [
  { key: 'credentials', label: 'Credentials', glyph: '◈', types: ['login', 'passkey'] },
  { key: 'finance', label: 'Finance', glyph: '▣', types: ['bank_account', 'card'] },
  { key: 'identity', label: 'Identity', glyph: '◉', types: ['identity'] },
  { key: 'developer', label: 'Developer', glyph: '</>', types: ['ssh_key', 'api_key'] },
  { key: 'notes', label: 'Secure Notes', glyph: '✎', types: ['secure_note'] },
  { key: 'media', label: 'Private Media', glyph: '▦', types: ['media'] },
  { key: 'documents', label: 'Documents', glyph: '▤', types: ['document'] },
  { key: 'collections', label: 'Collections', glyph: '▧', types: ['collection', 'custom'] },
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
  onLock: () => void;
  onExport: () => void;
  onImport: () => void;
  onShowRecovery: () => void;
}

function CountBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
      {n}
    </span>
  );
}

export default function Sidebar({
  view,
  setView,
  counts,
  tags,
  onLock,
  onExport,
  onImport,
  onShowRecovery,
}: SidebarProps) {
  const isActive = (v: SidebarView) => view === v;
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/80">
      <div className="px-4 pb-3 pt-5">
        <div className="text-lg font-semibold tracking-tight text-zinc-100">my-secrect</div>
        <div className="text-xs text-zinc-500">Local vault &middot; this device only</div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        <section>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Vaults
          </div>
          <button className={`nav-item ${isActive('all') ? 'nav-item-active' : ''}`} onClick={() => setView('all')}>
            <span>▤ All Items</span>
            <CountBadge n={counts.all} />
          </button>
          <button className={`nav-item ${isActive('favorites') ? 'nav-item-active' : ''}`} onClick={() => setView('favorites')}>
            <span>★ Favorites</span>
            <CountBadge n={counts.favorites} />
          </button>
          <button className={`nav-item ${isActive('trash') ? 'nav-item-active' : ''}`} onClick={() => setView('trash')}>
            <span>⌫ Trash</span>
            <CountBadge n={counts.trash} />
          </button>
          <button className={`nav-item ${isActive('archived') ? 'nav-item-active' : ''}`} onClick={() => setView('archived')}>
            <span>📦 Archived</span>
            <CountBadge n={counts.archived} />
          </button>
        </section>

        <section>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Library
          </div>
          <button className={`nav-item ${isActive('media-gallery') ? 'nav-item-active' : ''}`} onClick={() => setView('media-gallery')}>
            <span>🖼️ Media gallery</span>
          </button>
          <button className={`nav-item ${isActive('shares') ? 'nav-item-active' : ''}`} onClick={() => setView('shares')}>
            <span>↗ Sharing</span>
          </button>
        </section>

        <section>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Categories
          </div>
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`nav-item ${isActive(c.key) ? 'nav-item-active' : ''}`}
              onClick={() => setView(c.key)}
            >
              <span>
                {c.glyph} {c.label}
              </span>
              <CountBadge n={counts.categories[c.key] ?? 0} />
            </button>
          ))}
        </section>

        <section>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Security Health
          </div>
          <button className={`nav-item ${isActive('health') ? 'nav-item-active' : ''}`} onClick={() => setView('health')}>
            <span>◉ Watchtower</span>
            <CountBadge n={counts.health} />
          </button>
        </section>

        <section>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            App
          </div>
          <button className={`nav-item ${isActive('settings') ? 'nav-item-active' : ''}`} onClick={() => setView('settings')}>
            <span>⚙ Settings</span>
          </button>
        </section>

        {tags.length > 0 && (
          <section>
            <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Tags
            </div>
            <div className="flex flex-wrap gap-1.5 px-2">
              {tags.map((tag) => {
                const active = view === `tag:${tag}`;
                return (
                  <button
                    key={tag}
                    onClick={() => setView(`tag:${tag}`)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      active
                        ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    #{tag}
                    {counts.tags[tag] ? ` (${counts.tags[tag]})` : ''}
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </nav>

      <div className="space-y-1 border-t border-zinc-800 p-3">
        <button className="nav-item" onClick={onExport}>
          <span>↓ Export encrypted backup</span>
        </button>
        <button className="nav-item" onClick={onImport}>
          <span>↑ Import encrypted backup</span>
        </button>
        <button className="nav-item" onClick={onShowRecovery}>
          <span>⚿ Recovery key</span>
        </button>
        <button className="nav-item text-red-300 hover:bg-red-950/50 hover:text-red-200" onClick={onLock}>
          <span>🔒 Lock vault</span>
        </button>
      </div>
    </aside>
  );
}
