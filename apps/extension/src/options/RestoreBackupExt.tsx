import { useState } from 'react';
import type { ExtRequest, ExtResponse } from '../lib/messages';
import { describeRestoreError } from '../../../desktop/src/components/restoreErrors';
import { en } from '../../../../packages/i18n/src/index';
import type { ItemListCheck } from '../../../../packages/import-export/src/index';

/**
 * Restore an encrypted backup into an EMPTY extension profile. Lives on the
 * options page (a full tab) because the popup closes when the OS file
 * dialog opens. The file is read here and sent to the background, which
 * holds all keys; this page never sees a key. Any failure writes nothing.
 */
function send(req: ExtRequest): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res as ExtResponse);
    });
  });
}

export default function RestoreBackupExt({ vaultExists, onRestored }: { vaultExists: boolean; onRestored: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [itemList, setItemList] = useState<ItemListCheck | null>(null);
  const [busy, setBusy] = useState(false);

  if (count !== null) {
    return (
      <section className="card space-y-2" aria-label="Restore from backup" data-testid="restore-success">
        <h2 className="font-semibold">Restore from backup</h2>
        <p className="text-sm text-zinc-200">Backup restored: {count} {count === 1 ? 'item' : 'items'} decrypted and saved. The vault is locked — open the extension popup and unlock it normally.</p>
        {itemList === 'unverifiable-legacy' && (
          <p className="text-sm text-amber-300" role="alert" data-testid="restore-item-list-unverified">{en.backup.itemListUnverified}</p>
        )}
        <p className="text-xs text-zinc-400">This is a one-time copy. Changes made later here or on your other devices are not synced.</p>
      </section>
    );
  }
  if (vaultExists) {
    return (
      <section className="card space-y-2" aria-label="Restore from backup">
        <h2 className="font-semibold">Restore from backup</h2>
        <p className="text-sm text-zinc-400">A vault already exists in this extension. Restore never overwrites it. To replace it, wipe it deliberately below, then restore.</p>
        <p className="text-xs text-zinc-500" data-testid="restore-sync-note">Sync with your other devices is not available in the extension yet. Restoring an encrypted backup is the supported way to bring your vault here.</p>
      </section>
    );
  }

  const submit = async () => {
    setError('');
    if (!file) { setError('Choose a backup file first.'); return; }
    if (!secret.trim()) { setError(mode === 'passphrase' ? 'Enter the passphrase for this backup.' : 'Enter the recovery key.'); return; }
    setBusy(true);
    try {
      let json: string;
      try { json = await file.text(); } catch { setError('Could not read the selected file. Nothing was restored.'); return; }
      const res = await send({ type: 'restoreBackup', json, ...(mode === 'passphrase' ? { passphrase: secret } : { recoveryKey: secret }) });
      if (res.ok && 'restoredCount' in res) {
        setSecret('');
        setItemList(res.itemList);
        setCount(res.restoredCount);
        onRestored();
      } else {
        setError(describeRestoreError(new Error(res.ok ? 'restore failed' : res.error)).message);
      }
    } catch (e) {
      setError(describeRestoreError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3" aria-label="Restore from backup" data-testid="restore-backup">
      <h2 className="font-semibold">Restore from backup</h2>
      <p className="text-sm text-zinc-400">This extension has no vault yet. Restore an encrypted backup (format version 3, or 2 from older versions); nothing is overwritten.</p>
      <p className="text-sm text-zinc-400" data-testid="restore-sync-note">Sync with your other devices is not available in the extension yet. To use your desktop vault here, export an encrypted backup in the desktop app (Settings), then restore it below with that vault&apos;s passphrase or recovery key. The restored items are a one-time copy: later changes on either side are not synced.</p>
      <div>
        <label className="label" htmlFor="restore-file">Backup file</label>
        <input id="restore-file" type="file" accept="application/json,.json" className="input" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); }} />
      </div>
      <div className="flex gap-2" role="radiogroup" aria-label="Credential type">
        <button type="button" role="radio" aria-checked={mode === 'passphrase'} className={mode === 'passphrase' ? 'btn flex-1' : 'btn-secondary flex-1'} onClick={() => { setMode('passphrase'); setSecret(''); setError(''); }}>Passphrase</button>
        <button type="button" role="radio" aria-checked={mode === 'recovery'} className={mode === 'recovery' ? 'btn flex-1' : 'btn-secondary flex-1'} onClick={() => { setMode('recovery'); setSecret(''); setError(''); }}>Recovery key</button>
      </div>
      <div>
        <label className="label" htmlFor="restore-secret">{mode === 'passphrase' ? 'Backup passphrase' : 'Recovery key'}</label>
        <input id="restore-secret" type="password" className="input" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
      </div>
      {error && <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300" role="alert" data-testid="restore-error">{error}</p>}
      <button className="btn" disabled={busy} onClick={() => void submit()}>{busy ? 'Restoring…' : 'Restore backup'}</button>
    </section>
  );
}
