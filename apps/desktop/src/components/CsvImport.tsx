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
import { Alert, Button, Checkbox, Led } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

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
  const { dict, tp } = useTranslation();
  const c = dict.csvImport;
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
  const sourceName = source === 'bitwarden' ? 'Bitwarden' : '1Password';

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
      setError(c.readFailed);
    }
  };

  const dupReason = (index: number): string | undefined =>
    duplicates.find((d) => d.draftIndex === index)?.reason;

  const reset = () => {
    setDrafts([]);
    setSelected(new Set());
    setDuplicates([]);
    setSkipped([]);
    setWarnings([]);
    setSource(null);
  };

  const handleImport = async () => {
    const chosen = drafts.filter((_, i) => selected.has(i));
    if (chosen.length === 0) {
      setError(c.nothingSelected);
      return;
    }
    setImporting(true);
    try {
      await onImport(chosen.map(csvDraftToLoginItem));
      setDoneMessage(tp(c.imported, chosen.length, sourceName));
      reset();
    } catch {
      setError(c.failed);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div>
        <h4 className="ms-heading ms-heading--md">{c.title}</h4>
        <p className="ms-text-sm ms-text-muted mb-0 mt-1 ms-prose">{c.lede}</p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <div>
        <Button icon="file" onClick={() => fileInputRef.current?.click()}>
          {c.choose}
        </Button>
      </div>
      {error && <Alert tone="danger" announce>{error}</Alert>}
      {doneMessage && <Alert tone="success" announce>{doneMessage}</Alert>}
      {warnings.length > 0 && (
        <Alert tone="warning">
          <ul className="m-0 grid gap-1 pl-4">
            {warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
            {warnings.length > 5 && <li>{tp(c.moreWarnings, warnings.length - 5)}</li>}
          </ul>
        </Alert>
      )}
      {skipped.length > 0 && (
        <p className="ms-text-sm ms-text-muted m-0">
          {tp(c.skipped, skipped.length, `${skipped.slice(0, 8).map((s) => s.row).join(', ')}${skipped.length > 8 ? '…' : ''}`)}
        </p>
      )}
      {drafts.length > 0 && (
        <div className="grid gap-2">
          <p className="ms-text-sm m-0">
            {tp(c.found, drafts.length, sourceName)} · {format(c.selectedCount, selected.size)}
            {duplicates.length > 0 ? ` · ${tp(c.duplicatesLeft, duplicates.length)}` : ''}
          </p>
          <ul className="m-0 grid max-h-64 list-none gap-1 overflow-y-auto p-0">
            {drafts.map((draft, i) => {
              const reason = dupReason(i);
              const checked = selected.has(i);
              return (
                <li key={i} className="ms-card ms-card--pad-sm">
                  <Checkbox
                    checked={checked}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i); else next.delete(i);
                        return next;
                      });
                    }}
                    aria-label={format(c.importRow, draft.title)}
                    label={<span className="block truncate">{draft.title}</span>}
                    hint={
                      <>
                        <span className="block truncate">{[draft.username, draft.url].filter(Boolean).join(' · ') || c.noUserUrl}</span>
                        {reason && (
                          <span className="ms-copy-led"><Led tone="attention" /> {format(c.duplicate, reason)}</span>
                        )}
                        {!draft.password && <span className="block">{c.noPassword}</span>}
                      </>
                    }
                  />
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon="import" loading={importing} disabled={selected.size === 0} onClick={() => void handleImport()}>
              {importing ? c.importing : format(c.importSelected, selected.size)}
            </Button>
            <Button onClick={() => { reset(); setError(''); }}>
              {c.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
