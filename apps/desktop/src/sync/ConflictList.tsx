import { useState } from 'react';
import type { SyncConflict } from '../../../../packages/sync/src/index';
import type { VaultItem } from '../../../../packages/core/src/types';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

function VersionCard({ label, item, deleted, testId }: { label: string; item: VaultItem; deleted: boolean; testId: string }) {
  const { dict } = useTranslation();
  const t = dict.syncBar;
  const [reveal, setReveal] = useState(false);
  const entries = Object.entries(item.fields ?? {});
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-ms-line bg-ms-surface2 p-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-ms-muted">{label}</h4>
        <button type="button" className="text-xs text-ms-link hover:text-ms-text" aria-pressed={reveal} onClick={() => setReveal((v) => !v)}>
          {reveal ? t.hideValues : t.revealValues}
        </button>
      </div>
      {deleted ? (
        <p className="mt-2 text-sm text-ms-warn-text">{t.deletedElsewhere}</p>
      ) : (
        <>
          <p className="mt-2 break-words text-sm font-medium text-ms-text">{item.title}</p>
          <p className="text-xs text-ms-muted">{format(t.edited, item.updated_at)}</p>
          <dl className="mt-2 space-y-1 text-xs">
            {entries.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0 text-ms-muted">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-ms-text">{reveal ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : '••••••'}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

export interface ConflictListProps {
  conflicts: SyncConflict[];
  onKeepBoth: (conflictId: string) => void | Promise<void>;
  error?: string | null;
}

/**
 * Sync conflicts: both versions side by side (already decrypted locally).
 * The only resolution offered is 'Keep both': the other device's version is
 * saved as a copy and your item stays. 'Keep mine' / 'Keep theirs' are NOT
 * offered because the losing version would not be recoverable.
 */
export default function ConflictList({ conflicts, onKeepBoth, error }: ConflictListProps) {
  const { dict } = useTranslation();
  const t = dict.syncBar;
  const resolutionLabel: Record<SyncConflict['resolution'], string> = {
    unresolved: t.resolutions.unresolved,
    kept_local: t.resolutions.keptLocal,
    kept_remote: t.resolutions.keptRemote,
    kept_both: t.resolutions.keptBoth,
  };
  const unresolved = conflicts.filter((c) => c.resolution === 'unresolved');
  const resolved = conflicts.filter((c) => c.resolution !== 'unresolved');
  return (
    <section aria-label={t.conflictsTitle} data-testid="conflict-list" className="space-y-3 p-5">
      <h2 className="text-base font-semibold text-ms-text">{t.conflictsTitle}</h2>
      {error && <p role="alert" className="text-sm text-ms-danger-text">{error}</p>}
      {unresolved.length === 0 && <p className="text-sm text-ms-muted">{t.noConflicts}</p>}
      {unresolved.map((c) => (
        <article key={c.id} className="card space-y-3 p-4" data-testid="conflict-item">
          <p className="text-sm text-ms-text">
            {c.kind === 'delete_vs_update' ? t.deleteVsUpdate : t.editedBoth}
          </p>
          <div className="flex flex-col gap-3 md:flex-row">
            <VersionCard label={t.thisDevice} item={c.local} deleted={false} testId="conflict-local" />
            <VersionCard label={t.otherDevice} item={c.remote} deleted={c.kind === 'delete_vs_update'} testId="conflict-remote" />
          </div>
          <div className="flex items-center gap-3">
            <button type="button" className="btn-primary !py-1.5" onClick={() => void onKeepBoth(c.id)}>{t.keepBoth}</button>
            <span className="text-xs text-ms-muted">
              {c.kind === 'delete_vs_update' ? t.keepBothDeleteHint : t.keepBothEditHint}
            </span>
          </div>
        </article>
      ))}
      {resolved.length > 0 && (
        <details className="text-sm text-ms-muted">
          <summary className="cursor-pointer">{format(t.resolvedCount, resolved.length)}</summary>
          <ul className="mt-1 list-disc pl-5">
            {resolved.map((c) => (
              <li key={c.id}>{c.local.title} — {resolutionLabel[c.resolution]} {c.resolved_at ?? ''}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
