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
  signed_out: 'Signed out — sync stopped',
  vault_mismatch: 'Vault mismatch — sync off',
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
    status.state === 'error' || status.state === 'signed_out' || status.state === 'vault_mismatch' ? 'border-ms-danger-line bg-ms-danger-bg text-ms-danger-text'
    : status.state === 'offline' ? 'border-ms-warn-line bg-ms-warn-bg text-ms-warn-text'
    : 'border-ms-line bg-ms-surface2 text-ms-muted';
  const showConflicts = status.unresolvedConflicts > 0 || open;
  return (
    <div data-testid="sync-bar">
      <div className={`mx-5 mt-3 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-xs ${tone}`}>
        <span data-testid="sync-status" data-state={status.state} role="status" className="font-medium">{LABEL[status.state]}</span>
        {status.pending > 0 && <span data-testid="sync-pending">{status.pending} change{status.pending === 1 ? '' : 's'} waiting to upload</span>}
        {status.lastSyncedAt && status.state === 'idle' && <span className="text-ms-muted">last {status.lastSyncedAt}</span>}
        <button type="button" className="underline" onClick={onSyncNow}>Sync now</button>
        <button type="button" className="underline" data-testid="sync-conflicts-toggle" onClick={() => setOpen((v) => !v)}>
          {status.unresolvedConflicts > 0 ? `${status.unresolvedConflicts} conflict${status.unresolvedConflicts === 1 ? '' : 's'} to review` : 'Conflicts'}
        </button>
      </div>
      {status.error && (
        <pre data-testid="sync-error" role="alert" className="mx-5 mt-1 whitespace-pre-wrap rounded-lg border border-ms-line bg-ms-surface2 px-3 py-2 text-xs text-ms-muted">{status.error}</pre>
      )}
      {showConflicts && <ConflictList conflicts={conflicts} onKeepBoth={onKeepBoth} error={resolveError} />}
    </div>
  );
}
