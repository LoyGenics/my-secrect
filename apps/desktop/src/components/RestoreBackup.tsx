import { useState } from 'react';
import { restoreEncrypted, getVaultStats, lockVault } from '../vault';
import { describeRestoreError } from './restoreErrors';

/**
 * Fresh-device "Restore backup" flow. Mounted on the onboarding screen.
 *
 * restoreEncrypted() requires empty storage, decrypts EVERY item before
 * writing, and writes nothing on any failure. On success it leaves the
 * keys in memory; we lock immediately so the user must unlock normally.
 * Secrets are held in component state only until the attempt finishes.
 */
export function RestoreBackup({
  onRestored,
  onCancel,
}: {
  onRestored: (itemCount: number) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!file) {
      setError('Choose a backup file first.');
      return;
    }
    if (!secret.trim()) {
      setError(mode === 'passphrase' ? 'Enter the passphrase for this backup.' : 'Enter the recovery key.');
      return;
    }
    setBusy(true);
    try {
      let text: string;
      try {
        text = await file.text();
      } catch {
        setError('Could not read the selected file. Nothing was restored.');
        return;
      }
      try {
        await restoreEncrypted(text, mode === 'passphrase' ? { passphrase: secret } : { recoveryKey: secret });
      } catch (err) {
        setError(describeRestoreError(err).message);
        return;
      }
      const count = getVaultStats().total;
      lockVault(); // require a normal unlock after restore
      setSecret('');
      onRestored(count);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 space-y-3" data-testid="restore-backup">
      <p className="text-sm text-zinc-300">
        Restore an encrypted backup (format version 2) onto this device. The file never leaves your device and
        nothing is overwritten.
      </p>
      <div>
        <label className="label" htmlFor="restore-file">Backup file</label>
        <input
          id="restore-file"
          type="file"
          accept="application/json,.json"
          className="input"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); }}
        />
      </div>
      <div className="flex gap-2 text-xs" role="radiogroup" aria-label="Credential type">
        <button type="button" role="radio" aria-checked={mode === 'passphrase'} className={mode === 'passphrase' ? 'btn-primary flex-1' : 'btn-ghost flex-1'} onClick={() => { setMode('passphrase'); setSecret(''); setError(''); }}>Passphrase</button>
        <button type="button" role="radio" aria-checked={mode === 'recovery'} className={mode === 'recovery' ? 'btn-primary flex-1' : 'btn-ghost flex-1'} onClick={() => { setMode('recovery'); setSecret(''); setError(''); }}>Recovery key</button>
      </div>
      <div>
        <label className="label" htmlFor="restore-secret">{mode === 'passphrase' ? 'Backup passphrase' : 'Recovery key'}</label>
        <input
          id="restore-secret"
          type="password"
          className="input"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          aria-label={mode === 'passphrase' ? 'Backup passphrase' : 'Recovery key'}
        />
      </div>
      {error && <p role="alert" data-testid="restore-error" className="text-sm text-red-400">{error}</p>}
      <button className="btn-primary w-full" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Restoring…' : 'Restore backup'}
      </button>
      <button className="btn-ghost w-full" disabled={busy} onClick={onCancel}>Back to create vault</button>
    </div>
  );
}

export function RestoreSuccess({ itemCount, onContinue }: { itemCount: number; onContinue: () => void }) {
  return (
    <div className="mt-5 space-y-3 text-center" data-testid="restore-success">
      <p className="text-2xl">✓</p>
      <p className="text-sm text-zinc-300">
        Backup restored: {itemCount} {itemCount === 1 ? 'item' : 'items'} decrypted and saved. For your
        security the vault is locked. Unlock it with your passphrase (or recovery key).
      </p>
      <button className="btn-primary w-full" onClick={onContinue}>Continue to unlock</button>
    </div>
  );
}
