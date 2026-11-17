import { useState } from 'react';
import type { SyncConflict } from '../../../../packages/sync/src/index';
import type { SyncStatus } from './engine';
import ConflictList from './ConflictList';

const LABEL: Record<SyncStatus['state'], string> = {
  disabled: 'Sync off',
  idle: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  error: 'Sync error',
};

export interface SyncBarProps {
  status: SyncStatus;
  conflicts: SyncConflict[];
  onSyncNow: () => void;
  onKeepBoth: (conflictId: string) => void | Promise<void>;
  resolveError: string | null;
}

/** Sync status indicator (idle / syncing / offline / error with visible text) + conflicts panel. */
export default function SyncBar({ status, conflicts, onSyncNow, onKeepBoth, resolveError }: SyncBarProps) {
  const [open, setOpen] = useState(false);
  if (status.state === 'disabled') return null;
  const tone =
    status.state === 'error' ? 'border-red-900/60 bg-red-950/40 text-red-200'
    : status.state === 'offline' ? 'border-amber-900/60 bg-amber-950/40 text-amber-200'
    : 'border-zinc-800 bg-zinc-900 text-zinc-300';
  const showConflicts = status.unresolvedConflicts > 0 || open;
  return (
    <div data-testid="sync-bar">
      <div className={`mx-5 mt-3 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-xs ${tone}`}>
        <span data-testid="sync-status" data-state={status.state} role="status" className="font-medium">{LABEL[status.state]}</span>
        {status.pending > 0 && <span data-testid="sync-pending">{status.pending} change{status.pending === 1 ? '' : 's'} waiting to upload</span>}
        {status.lastSyncedAt && status.state === 'idle' && <span className="text-zinc-500">last {status.lastSyncedAt}</span>}
        <button type="button" className="underline" onClick={onSyncNow}>Sync now</button>
        <button type="button" className="underline" data-testid="sync-conflicts-toggle" onClick={() => setOpen((v) => !v)}>
          {status.unresolvedConflicts > 0 ? `${status.unresolvedConflicts} conflict${status.unresolvedConflicts === 1 ? '' : 's'} to review` : 'Conflicts'}
        </button>
      </div>
      {status.error && (
        <pre data-testid="sync-error" role="alert" className="mx-5 mt-1 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">{status.error}</pre>
      )}
      {showConflicts && <ConflictList conflicts={conflicts} onKeepBoth={onKeepBoth} error={resolveError} />}
    </div>
  );
}
