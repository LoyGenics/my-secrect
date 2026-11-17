import { useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import CsvImport from './CsvImport';

export type AutoLockMinutes = 1 | 5 | 15 | 0;

interface SettingsViewProps {
  autoLockMinutes: AutoLockMinutes;
  onAutoLockChange: (minutes: AutoLockMinutes) => void;
  itemCount: number;
  onExportEncrypted: () => void;
  onExportPlaintext: () => void;
  /**
   * Plaintext export is DESKTOP-ONLY. The web client renders this same
   * SettingsView through the shared desktop App, so it must pass false
   * here — otherwise the banner's "encrypted-only" claim would be a lie
   * (see H2: the plaintext button used to be reachable on web).
   * Defaults to true for the desktop app.
   */
  allowPlaintextExport?: boolean;
  onImport: () => void;
  /** CSV import (1Password / Bitwarden). Optional: hidden when absent. */
  existingItems?: VaultItem[];
  onImportCsv?: (items: VaultItem[]) => Promise<void> | void;
  onChangePassphrase: (oldPassphrase: string, newPassphrase: string) => Promise<void>;
  onWipeVault: () => void;
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SettingsView({
  autoLockMinutes,
  onAutoLockChange,
  itemCount,
  onExportEncrypted,
  onExportPlaintext,
  allowPlaintextExport = true,
  onImport,
  existingItems,
  onImportCsv,
  onChangePassphrase,
  onWipeVault,
}: SettingsViewProps) {
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [passMessage, setPassMessage] = useState('');
  const [passError, setPassError] = useState('');
  const [changing, setChanging] = useState(false);
  const [plaintextAck, setPlaintextAck] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [wipeArmed, setWipeArmed] = useState(false);

  const handleChangePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassError('');
    setPassMessage('');
    if (newPass.length < 8) {
      setPassError('New passphrase must be at least 8 characters.');
      return;
    }
    if (newPass !== newPassConfirm) {
      setPassError('New passphrases do not match.');
      return;
    }
    if (newPass === oldPass) {
      setPassError('New passphrase must be different from the current one.');
      return;
    }
    setChanging(true);
    try {
      await onChangePassphrase(oldPass, newPass);
      setPassMessage('Passphrase changed. Your items were not re-encrypted — the same master key is now wrapped under the new passphrase. Your recovery key still works.');
      setOldPass('');
      setNewPass('');
      setNewPassConfirm('');
    } catch (err) {
      setPassError(err instanceof Error ? err.message : 'Could not change passphrase.');
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-5">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="mt-1 text-sm text-zinc-400">
          {itemCount} item{itemCount === 1 ? '' : 's'} in this vault · Local vault, this device only.
        </p>
      </div>

      {/* Change master passphrase */}
      <section className="card p-5" aria-labelledby="settings-passphrase-heading">
        <h3 id="settings-passphrase-heading" className="text-base font-semibold">Change master passphrase</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Your current passphrase is verified first. The master key is re-wrapped under the new
          passphrase — your items are not re-encrypted and nothing is lost. Your recovery key
          still works after the change.
        </p>
        <form className="mt-4 space-y-3" onSubmit={(e) => void handleChangePassphrase(e)}>
          <div>
            <label className="label" htmlFor="settings-current-passphrase">Current passphrase</label>
            <input
              id="settings-current-passphrase"
              name="current-passphrase"
              type="password"
              className="input"
              value={oldPass}
              onChange={(e) => setOldPass(e.target.value)}
              placeholder="Enter your current passphrase"
              autoComplete="current-password"
              aria-label="Current passphrase"
            />
          </div>
          <div>
            <label className="label" htmlFor="settings-new-passphrase">New passphrase</label>
            <input
              id="settings-new-passphrase"
              name="new-passphrase"
              type="password"
              className="input"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              aria-label="New passphrase"
            />
          </div>
          <div>
            <label className="label" htmlFor="settings-confirm-new-passphrase">Confirm new passphrase</label>
            <input
              id="settings-confirm-new-passphrase"
              name="confirm-new-passphrase"
              type="password"
              className="input"
              value={newPassConfirm}
              onChange={(e) => setNewPassConfirm(e.target.value)}
              placeholder="Repeat the new passphrase"
              autoComplete="new-password"
              aria-label="Confirm new passphrase"
            />
          </div>
          {passError && <p role="alert" className="text-sm text-red-400">{passError}</p>}
          {passMessage && <p role="status" className="text-sm text-emerald-400">{passMessage}</p>}
          <button type="submit" className="btn-primary" disabled={changing || !oldPass || !newPass}>
            {changing ? 'Changing…' : 'Change passphrase'}
          </button>
        </form>
      </section>

      {/* Auto-lock */}
      <section className="card p-5" aria-labelledby="settings-autolock-heading">
        <h3 id="settings-autolock-heading" className="text-base font-semibold">Auto-lock</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Lock the vault automatically after inactivity. Locking clears the keys from memory.
        </p>
        <div className="mt-3">
          <label className="label" htmlFor="settings-auto-lock">Auto-lock after</label>
          <select
            id="settings-auto-lock"
            name="auto-lock"
            className="input max-w-xs"
            value={autoLockMinutes}
            onChange={(e) => onAutoLockChange(Number(e.target.value) as AutoLockMinutes)}
            aria-label="Auto-lock after"
          >
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={0}>Never</option>
          </select>
        </div>
      </section>

      {/* Recovery key */}
      <section className="card p-5" aria-labelledby="settings-recovery-heading">
        <h3 id="settings-recovery-heading" className="text-base font-semibold">Recovery key</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Your recovery key was shown only once, when this vault was created, and it cannot be
          displayed again — that is deliberate, so no one who opens this screen can copy it.
          If you still have it, lock the vault and choose “Unlock with a recovery key…” on the
          lock screen. If you have lost both your passphrase and your recovery key, the vault
          cannot be recovered: there is no reset and no back door.
        </p>
      </section>

      {/* Backup */}
      <section className="card p-5" aria-labelledby="settings-backup-heading">
        <h3 id="settings-backup-heading" className="text-base font-semibold">Backup</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" onClick={onExportEncrypted}>
            ↓ Export encrypted backup
          </button>
          <button type="button" className="btn-ghost" onClick={onImport}>
            ↑ Import encrypted backup
          </button>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          Encrypted backups stay encrypted — they can only be imported into a vault with the same keys.
        </p>
        {allowPlaintextExport ? (
          <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 p-4">
            <h4 className="text-sm font-semibold text-red-200">Export plaintext (dangerous — desktop only)</h4>
            <p className="mt-1 text-sm text-zinc-300">
              This writes every item in readable form — usernames, passwords, API keys, notes —
              into a plain JSON file. Anyone who gets that file gets everything. Only do this on
              a device you trust, and delete the file as soon as you are done with it.
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm text-zinc-200">
              <input
                id="settings-plaintext-ack"
                name="plaintext-export-ack"
                type="checkbox"
                checked={plaintextAck}
                onChange={(e) => setPlaintextAck(e.target.checked)}
                className="mt-1 accent-red-600"
                aria-label="I understand a plaintext export contains all my secrets in readable form"
              />
              I understand a plaintext export contains all my secrets in readable form.
            </label>
            <button
              type="button"
              className="btn-danger mt-3"
              disabled={!plaintextAck}
              onClick={() => {
                onExportPlaintext();
                setPlaintextAck(false);
              }}
            >
              Export plaintext JSON
            </button>
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <h4 className="text-sm font-semibold text-zinc-200">Plaintext export is disabled here</h4>
            <p className="mt-1 text-sm text-zinc-400">
              This client offers encrypted-only export: vault data leaves the browser only in
              encrypted form. For a plaintext export, use the desktop app — it requires an
              explicit warning acknowledgement first.
            </p>
          </div>
        )}
        {existingItems && onImportCsv && (
          <div className="mt-4 border-t border-zinc-800 pt-4">
            <CsvImport existingItems={existingItems} onImport={onImportCsv} />
          </div>
        )}
      </section>

      {/* App info */}
      <section className="card p-5" aria-labelledby="settings-about-heading">
        <h3 id="settings-about-heading" className="text-base font-semibold">About this app</h3>
        <dl className="mt-2 space-y-1 text-sm text-zinc-300">
          <div className="flex gap-2"><dt className="w-32 shrink-0 text-zinc-500">Version</dt><dd>0.1.0 (local prototype)</dd></div>
          <div className="flex gap-2"><dt className="w-32 shrink-0 text-zinc-500">Encryption</dt><dd>Argon2id + XChaCha20-Poly1305 via libsodium</dd></div>
          <div className="flex gap-2"><dt className="w-32 shrink-0 text-zinc-500">Storage</dt><dd>Local only — no server, no sync yet</dd></div>
          <div className="flex gap-2"><dt className="w-32 shrink-0 text-zinc-500">Audit</dt><dd>Not audited — do not treat as production-ready</dd></div>
        </dl>
      </section>

      {/* Danger zone: wipe vault */}
      <section className="card border-red-900/60 p-5" aria-labelledby="settings-wipe-heading">
        <h3 id="settings-wipe-heading" className="text-base font-semibold text-red-200">Danger zone — wipe vault</h3>
        <p className="mt-1 text-sm text-zinc-300">
          This permanently deletes every item, the encrypted store and the wrapped keys on this
          device. It cannot be undone. An encrypted backup is the only way back — make one first
          if you want to keep anything.
        </p>
        {!wipeArmed ? (
          <button type="button" className="btn-danger mt-3" onClick={() => setWipeArmed(true)}>
            Wipe vault…
          </button>
        ) : (
          <div className="mt-3 space-y-3">
            <div>
              <label className="label" htmlFor="settings-wipe-confirm">Type DELETE to confirm</label>
              <input
                id="settings-wipe-confirm"
                name="wipe-confirm"
                type="text"
                className="input"
                value={wipeText}
                onChange={(e) => setWipeText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                aria-label="Type DELETE to confirm wiping the vault"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-danger"
                disabled={wipeText.trim() !== 'DELETE'}
                onClick={onWipeVault}
              >
                Permanently wipe vault
              </button>
              <button type="button" className="btn-ghost" onClick={() => { setWipeArmed(false); setWipeText(''); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export { downloadText };
