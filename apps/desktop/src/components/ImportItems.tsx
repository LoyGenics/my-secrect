import { useEffect, useRef, useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import {
  CSV_SOURCE_NAMES, LOGIN_CSV_TEMPLATE, MAX_IMPORT_ITEMS, detectCsvDuplicates, parseCsvImport,
} from '../../../../packages/import-export/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';
import { AiImportError, MAX_AI_SOURCE_BYTES, requestAiPreview } from '../utils/aiImport';
import { csvDraftToLoginItem } from '../utils/csvImport';
import { Alert, Button, Checkbox, Dialog, DialogActions, Field, SegmentedControl, Textarea } from '../theme';

const MAX_CSV_BYTES = 8 * 1024 * 1024;

interface ImportItemsProps {
  existingItems: VaultItem[];
  onImport: (items: VaultItem[]) => Promise<void>;
  aiApiBaseUrl?: string;
  onDownloadTemplate: (filename: string, text: string, type: string) => void;
}

interface Preview {
  source: string;
  items: VaultItem[];
  skipped: number[];
  duplicates: Map<string, boolean>;
  totpOmitted: Set<string>;
}

function fieldText(item: VaultItem, key: string): string {
  const value = item.fields[key];
  return typeof value === 'string' ? value : '';
}

export default function ImportItems({ existingItems, onImport, aiApiBaseUrl, onDownloadTemplate }: ImportItemsProps) {
  const { dict, tp } = useTranslation();
  const c = dict.itemImport;
  const [mode, setMode] = useState<'csv' | 'ai'>('csv');
  const [sourceText, setSourceText] = useState('');
  const [consentOpen, setConsentOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const operation = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseFile = useRef<HTMLButtonElement>(null);
  const sourceBytes = new TextEncoder().encode(sourceText).byteLength;

  useEffect(() => () => operation.current?.abort(), []);

  function clearPreview() {
    operation.current?.abort();
    setReading(false);
    setPreview(null);
    setSelected(new Set());
    setError('');
    setDone('');
  }

  function changeMode(next: 'csv' | 'ai') {
    setConsentOpen(false);
    setSourceText('');
    clearPreview();
    setMode(next);
  }

  function showPreview(data: Omit<Preview, 'duplicates'>) {
    const logins = data.items.filter((item) => item.type === 'login');
    const drafts = logins.map((item) => ({
      title: item.title,
      username: fieldText(item, 'username'),
      url: fieldText(item, 'url'),
      password: '',
      notes: '',
    }));
    const duplicates = new Map(
      detectCsvDuplicates(drafts, existingItems).map((dupe) => [logins[dupe.draftIndex].id, dupe.fromBatch === true]),
    );
    setPreview({ ...data, duplicates });
    setSelected(new Set(data.items.filter((item) => !duplicates.has(item.id)).map((item) => item.id)));
    if (data.items.length === 0 && data.skipped.length === 0) setError(c.noItems);
  }

  function beginPreview(): AbortSignal {
    clearPreview();
    const controller = new AbortController();
    operation.current = controller;
    setReading(true);
    return controller.signal;
  }

  async function handleFile(file: File) {
    const signal = beginPreview();
    try {
      if (file.size > MAX_CSV_BYTES) {
        setError(c.fileTooLarge);
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (signal.aborted) return;
      const result = parseCsvImport(text);
      if (!result.source || result.errors.length > 0) {
        const issue = result.errors[0];
        setError(issue === 'too_many_rows' ? format(c.tooManyRows, MAX_IMPORT_ITEMS) : c.csvErrors[issue ?? 'unrecognized']);
        return;
      }
      const items = result.drafts.map(csvDraftToLoginItem);
      showPreview({
        source: CSV_SOURCE_NAMES[result.source],
        items,
        skipped: result.skipped.map(({ row }) => row),
        totpOmitted: new Set(items.filter((item, i) => {
          const totp = result.drafts[i].totp;
          return totp && !item.fields.totp_secret;
        }).map((item) => item.id)),
      });
    } catch {
      if (!signal.aborted) setError(c.readFailed);
    } finally {
      if (!signal.aborted) setReading(false);
    }
  }

  async function handleAi() {
    setConsentOpen(false);
    if (!aiApiBaseUrl || !sourceText.trim() || sourceBytes > MAX_AI_SOURCE_BYTES) return;
    const signal = beginPreview();
    try {
      const result = await requestAiPreview(aiApiBaseUrl, sourceText, signal);
      if (signal.aborted) return;
      setSourceText('');
      showPreview({ ...result, source: 'OpenAI' });
    } catch (err) {
      if (signal.aborted) return;
      const status = err instanceof AiImportError ? err.status : 0;
      setError(status === 401 ? c.signIn : status === 429 ? c.rateLimited : status === 503 ? c.aiUnavailable : c.aiFailed);
    } finally {
      if (!signal.aborted) setReading(false);
    }
  }

  async function handleImport() {
    const items = preview?.items.filter((item) => selected.has(item.id)) ?? [];
    if (items.length === 0) return;
    setImporting(true);
    setError('');
    try {
      await onImport(items);
      clearPreview();
      setDone(tp(c.imported, items.length));
    } catch {
      setError(c.failed);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="grid gap-3">
      <SegmentedControl
        ariaLabel={c.method}
        value={mode}
        onChange={changeMode}
        disabled={importing}
        options={[{ value: 'csv', label: c.csvTab }, { value: 'ai', label: c.aiTab }]}
      />
      {mode === 'csv' ? (
        <>
          <p className="ms-text-sm ms-text-muted m-0 ms-prose">{c.csvLede}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={chooseFile} icon="file" loading={reading} disabled={importing} onClick={() => fileInput.current?.click()}>
              {reading ? c.reading : c.choose}
            </Button>
            <Button icon="export" onClick={() => onDownloadTemplate('my-secret-logins.csv', LOGIN_CSV_TEMPLATE, 'text/csv;charset=utf-8')}>
              {c.template}
            </Button>
          </div>
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden tabIndex={-1} onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleFile(file);
          }} />
        </>
      ) : aiApiBaseUrl ? (
        <>
          <Field label={c.textLabel} hint={c.textHint} error={sourceBytes > MAX_AI_SOURCE_BYTES ? c.textTooLarge : undefined}>
            <Textarea rows={5} value={sourceText} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
              disabled={reading || importing} onChange={(e) => setSourceText(e.target.value)} />
          </Field>
          <div>
            <Button loading={reading} disabled={importing || !sourceText.trim() || sourceBytes > MAX_AI_SOURCE_BYTES}
              onClick={() => setConsentOpen(true)}>
              {reading ? c.analyzing : c.analyze}
            </Button>
          </div>
        </>
      ) : (
        <Alert tone="info">{c.signIn}</Alert>
      )}

      <Dialog open={consentOpen} onOpenChange={setConsentOpen} title={c.consentTitle} description={c.consentDescription}>
        <p className="ms-text-sm ms-text-secondary">{c.consentData}</p>
        <p className="ms-text-sm ms-text-secondary">{c.consentLiability}</p>
        <a className="ms-text-sm underline" href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noreferrer">
          {c.dataPolicy}
        </a>
        <DialogActions>
          <Button onClick={() => {
            changeMode('csv');
            requestAnimationFrame(() => chooseFile.current?.focus());
          }}>{c.csvInstead}</Button>
          <Button variant="primary" onClick={() => void handleAi()}>{c.acceptAndSend}</Button>
        </DialogActions>
      </Dialog>

      {error && <Alert tone="danger" announce>{error}</Alert>}
      {done && <Alert tone="success" announce>{done}</Alert>}
      {preview && preview.skipped.length > 0 && (
        <Alert tone="warning">
          {tp(mode === 'csv' ? c.csvSkipped : c.aiSkipped, preview.skipped.length,
            preview.skipped.slice(0, 8).join(', ') + (preview.skipped.length > 8 ? '…' : ''))}
        </Alert>
      )}
      {preview && preview.items.length > 0 && (
        <>
          <p className="ms-text-sm m-0" role="status">
            {tp(c.found, preview.items.length, preview.source)} · {format(c.selected, selected.size)}
          </p>
          <ul className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
            {preview.items.map((item) => (
              <li key={item.id} className="ms-card ms-card--pad-sm">
                <Checkbox
                  checked={selected.has(item.id)}
                  disabled={importing}
                  aria-label={format(c.importRow, item.title)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(item.id); else next.delete(item.id);
                      return next;
                    });
                  }}
                  label={<span className="block break-words">{item.title}</span>}
                  hint={
                    <>
                      <span className="block break-words">{[dict.itemTypes[item.type], fieldText(item, 'username'), fieldText(item, 'url')].filter(Boolean).join(' · ')}</span>
                      {preview.duplicates.has(item.id) && (
                        <span className="block">{preview.duplicates.get(item.id) ? c.duplicateBatch : c.duplicateVault}</span>
                      )}
                      {preview.totpOmitted.has(item.id) && <span className="block">{c.totpOmitted}</span>}
                      {item.type === 'login' && !fieldText(item, 'password') && <span className="block">{c.noPassword}</span>}
                    </>
                  }
                />
                {mode === 'ai' && (
                  <details className="ml-7 mt-2 ms-text-sm">
                    <summary>{c.reviewFields}</summary>
                    <dl className="my-2 grid gap-2">
                      {Object.entries(item.fields).map(([key, value]) => (
                        <div key={key}>
                          <dt className="ms-text-muted">{dict.fields[key as keyof typeof dict.fields] ?? key}</dt>
                          <dd className="m-0 whitespace-pre-wrap break-words">{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon="import" loading={importing} disabled={reading || selected.size === 0} onClick={() => void handleImport()}>
              {importing ? c.importing : format(c.importSelected, selected.size)}
            </Button>
            <Button disabled={importing || reading} onClick={clearPreview}>{dict.common.cancel}</Button>
          </div>
        </>
      )}
    </div>
  );
}
