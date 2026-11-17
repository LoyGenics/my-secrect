import { useMemo } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import { computeHealth } from '../utils/health';

export interface HealthViewProps {
  items: VaultItem[];
  onFix: (item: VaultItem) => void;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 50) return 'text-amber-400';
  return 'text-red-400';
}

function scoreBarColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

export default function HealthView({ items, onFix }: HealthViewProps) {
  const report = useMemo(() => computeHealth(items), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  return (
    <div className="space-y-4">
      <div className="card gradient-subtle p-5">
        <div className="flex items-center gap-5">
          <div className="flex flex-col items-center">
            <span className={`text-4xl font-bold ${scoreColor(report.score)}`}>{report.score}</span>
            <span className="text-xs text-zinc-400">/ 100</span>
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-zinc-100">Vault health</h2>
            <p className="text-sm text-zinc-400">
              {report.total} {report.total === 1 ? 'item' : 'items'} checked · {report.weakCount} weak{' '}
              {report.weakCount === 1 ? 'password' : 'passwords'} · {report.reusedCount} reused{' '}
              {report.reusedCount === 1 ? 'password' : 'passwords'}
            </p>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all ${scoreBarColor(report.score)}`}
                style={{ width: `${Math.max(0, Math.min(100, report.score))}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-5">
          <h3 className="text-sm font-semibold text-zinc-100">Weak passwords</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Short or low-complexity passwords found in logins and other credential items.
          </p>
          {report.weakItems.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-400">No weak passwords found.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {report.weakItems.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-100">{item.title}</span>
                    <span className="text-xs text-zinc-500">{item.type}</span>
                  </span>
                  <button className="btn-ghost shrink-0 !px-2.5 !py-1.5 !text-xs" onClick={() => onFix(item)}>
                    Fix
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5">
          <h3 className="text-sm font-semibold text-zinc-100">Reused passwords</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            The same password used on more than one item. Change each group to a unique password.
          </p>
          {report.reusedGroups.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-400">No reused passwords found.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {report.reusedGroups.map((group, gi) => (
                <li key={gi} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <div className="text-xs font-medium text-zinc-400">
                    Shared by {group.itemIds.length} {group.itemIds.length === 1 ? 'item' : 'items'}
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {group.itemIds.map((id) => {
                      const item = byId.get(id);
                      if (!item) return null;
                      return (
                        <li key={id} className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm text-zinc-100">{item.title}</span>
                          <button className="btn-ghost shrink-0 !px-2.5 !py-1 !text-xs" onClick={() => onFix(item)}>
                            Fix
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {report.total === 0 && (
        <p className="text-sm text-zinc-500">
          Add some login items and this view will score their passwords.
        </p>
      )}
    </div>
  );
}
