import { useRef, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import {
  parseCsvImport,
  detectCsvDuplicates,
  type CsvDraft,
  type CsvDuplicate,
  type CsvSource,
} from '../../../../packages/import-export/src/index';
import { csvDraftToLoginItem } from '../utils/csvImport';

/**
 * CSV import (desktop only) — 1Password / Bitwarden exports.
 *
 * Flow: choose a .csv file → parse + validate locally (nothing leaves
 * the device) → preview with duplicates flagged → import the checked
 * rows as encrypted login items. Duplicates (same site + username, or
 * same title + username) are UNCHECKED by default so an import never
 * creates silent duplicates; the user can re-check one to import it
 * anyway. Rows with no title/URL/username are skipped and listed.
 * Passwords are never displayed in the preview — only titles,
 * usernames and URLs.
 */

interface CsvImportProps {
  existingItems: VaultItem[];
  onImport: (items: VaultItem[]) => Promise<void> | void;
}

export default function CsvImport({ existingItems, onImport }: CsvImportProps) {
  const [source, setSource] = useState<CsvSource | null>(null);
  const [drafts, setDrafts] = useState<CsvDraft[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [duplicates, setDuplicates] = useState<CsvDuplicate[]>([]);
  const [skipped, setSkipped] = useState<Array<{ row: number; reason: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError('');
    setDoneMessage('');
    setWarnings([]);
    try {
      const text = await file.text();
      const result = parseCsvImport(text);
      if (result.errors.length > 0) {
        setError(result.errors.join(' '));
        setDrafts([]);
        setSelected(new Set());
        setDuplicates([]);
        setSkipped([]);
        setSource(null);
        return;
      }
      const dups = detectCsvDuplicates(result.drafts, existingItems);
      const dupIndexes = new Set(dups.map((d) => d.draftIndex));
      const initiallySelected = new Set(result.drafts.map((_, i) => i).filter((i) => !dupIndexes.has(i)));
      setSource(result.source);
      setDrafts(result.drafts);
      setSelected(initiallySelected);
      setDuplicates(dups);
      setSkipped(result.skipped);
      setWarnings(result.warnings);
    } catch {
      setError('Could not read that file. Choose a .csv export from 1Password or Bitwarden.');
    }
  };

  const dupReason = (index: number): string | undefined =>
    duplicates.find((d) => d.draftIndex === index)?.reason;

  const handleImport = async () => {
    const chosen = drafts.filter((_, i) => selected.has(i));
    if (chosen.length === 0) {
      setError('Nothing selected to import.');
      return;
    }
    setImporting(true);
    try {
      await onImport(chosen.map(csvDraftToLoginItem));
      setDoneMessage(`Imported ${chosen.length} login${chosen.length === 1 ? '' : 's'} from ${source === 'bitwarden' ? 'Bitwarden' : '1Password'}. They are tagged “imported”.`);
      setDrafts([]);
      setSelected(new Set());
      setDuplicates([]);
      setSkipped([]);
      setWarnings([]);
      setSource(null);
    } catch {
      setError('Import failed while saving items. Nothing was partially imported — try again.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <h4 className="text-sm font-semibold text-zinc-100">Import from 1Password / Bitwarden (CSV)</h4>
      <p className="mt-1 text-sm text-zinc-400">
        Import a CSV export from 1Password or Bitwarden. The file is parsed on this device only;
        duplicates already in the vault are left unchecked.
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <button type="button" className="btn-ghost mt-3" onClick={() => fileInputRef.current?.click()}>
        Choose CSV file…
      </button>
      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      {doneMessage && <p role="status" className="mt-3 text-sm text-emerald-400">{doneMessage}</p>}
      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-amber-300">
          {warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
          {warnings.length > 5 && <li>…and {warnings.length - 5} more warning(s).</li>}
        </ul>
      )}
      {skipped.length > 0 && (
        <p className="mt-2 text-sm text-zinc-400">
          Skipped {skipped.length} row(s) with no title, URL or username: rows{' '}
          {skipped.slice(0, 8).map((s) => s.row).join(', ')}{skipped.length > 8 ? '…' : ''}.
        </p>
      )}
      {drafts.length > 0 && (
        <div className="mt-4">
          <p className="text-sm text-zinc-300">
            {drafts.length} login{drafts.length === 1 ? '' : 's'} found in the {source === 'bitwarden' ? 'Bitwarden' : '1Password'} file ·{' '}
            {selected.size} selected{duplicates.length > 0 ? ` · ${duplicates.length} duplicate(s) left unchecked` : ''}.
          </p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {drafts.map((draft, i) => {
              const reason = dupReason(i);
              const checked = selected.has(i);
              return (
                <li key={i} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i); else next.delete(i);
                        return next;
                      });
                    }}
                    className="mt-1 accent-indigo-600"
                    aria-label={`Import ${draft.title}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{draft.title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {[draft.username, draft.url].filter(Boolean).join(' · ') || 'No username or URL'}
                    </span>
                    {reason && <span className="block text-xs text-amber-400">Duplicate: {reason}.</span>}
                    {!draft.password && <span className="block text-xs text-zinc-500">No password in this row.</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary" disabled={importing || selected.size === 0} onClick={() => void handleImport()}>
              {importing ? 'Importing…' : `Import ${selected.size} selected`}
            </button>
            <button type="button" className="btn-ghost" onClick={() => { setDrafts([]); setSelected(new Set()); setDuplicates([]); setSkipped([]); setWarnings([]); setSource(null); setError(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
