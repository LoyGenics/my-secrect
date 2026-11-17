import { useState } from 'react';
import { restoreEncrypted, getVaultStats, lockVault } from '../vault';
import { describeRestoreError } from './restoreErrors';
import { Alert, Button, EmptyState, Field, Input, SegmentedControl, illustrations } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';

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
  const { dict } = useTranslation();
  const r = dict.restore;
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!file) {
      setError(r.chooseFile);
      return;
    }
    if (!secret.trim()) {
      setError(mode === 'passphrase' ? r.enterPassphrase : r.enterRecovery);
      return;
    }
    setBusy(true);
    try {
      let text: string;
      try {
        text = await file.text();
      } catch {
        setError(r.readFailed);
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

  const secretLabel = mode === 'passphrase' ? r.backupPassphrase : r.recoveryKey;

  return (
    <div className="ms-device__body" data-testid="restore-backup">
      <p className="ms-text-sm ms-text-secondary m-0">{r.lede}</p>
      <Field id="restore-file" label={r.file} className="mb-0">
        <Input
          type="file"
          accept="application/json,.json"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); }}
        />
      </Field>
      <SegmentedControl<'passphrase' | 'recovery'>
        ariaLabel={r.credentialType}
        value={mode}
        className="w-full [&>button]:flex-1"
        options={[
          { value: 'passphrase', label: r.passphrase },
          { value: 'recovery', label: r.recoveryKey },
        ]}
        onChange={(next) => { setMode(next); setSecret(''); setError(''); }}
      />
      <Field id="restore-secret" label={secretLabel} className="mb-0">
        <Input
          type="password"
          value={secret}
          mono={mode === 'recovery'}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          aria-label={secretLabel}
        />
      </Field>
      {error && (
        <Alert tone="danger" announce>
          <span data-testid="restore-error">{error}</span>
        </Alert>
      )}
      <Button variant="primary" block size="lg" icon="restore" loading={busy} onClick={() => void submit()}>
        {busy ? r.restoring : r.restore}
      </Button>
      <Button block icon="back" disabled={busy} onClick={onCancel}>{r.back}</Button>
    </div>
  );
}

export function RestoreSuccess({ itemCount, onContinue }: { itemCount: number; onContinue: () => void }) {
  const { dict, tp } = useTranslation();
  const r = dict.restore;
  return (
    <div data-testid="restore-success">
      <EmptyState
        art={illustrations.success}
        title={r.successTitle}
        body={tp(r.successBody, itemCount)}
        primaryAction={{ label: r.continue, icon: 'unlock', onClick: onContinue }}
        className="py-4"
      />
    </div>
  );
}
