import { useEffect, useState } from 'react';
import type { ExtRequest, ExtResponse } from '../lib/messages';
import RestoreBackupExt from './RestoreBackupExt';
import { DEFAULT_SETTINGS, type AutoLockMinutes, type ExtSettings } from '../lib/settings';

/**
 * Options page. Settings only — no keys, no vault contents here either.
 * Change-passphrase and wipe go through the background like everything else.
 */

function send(req: ExtRequest): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res as ExtResponse);
    });
  });
}

export default function Options() {
  const [settings, setSettings] = useState<ExtSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [allowedText, setAllowedText] = useState('');
  const [blockedText, setBlockedText] = useState('');
  const [locked, setLocked] = useState(true);
  const [vaultExists, setVaultExists] = useState(true);
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [wipeConfirm, setWipeConfirm] = useState('');

  useEffect(() => {
    void send({ type: 'getSettings' }).then((res) => {
      if (res.ok && 'settings' in res) {
        setSettings(res.settings);
        setAllowedText(res.settings.allowedOrigins.join('\n'));
        setBlockedText(res.settings.blockedOrigins.join('\n'));
      }
      setLoaded(true);
    });
    void send({ type: 'getStatus' }).then((res) => {
      if (res.ok && 'status' in res) { setLocked(res.status.locked); setVaultExists(res.status.vaultExists); }
    });
  }, []);

  const save = async () => {
    setError('');
    const next: ExtSettings = {
      ...settings,
      allowedOrigins: allowedText.split('\n').map((s) => s.trim()).filter(Boolean),
      blockedOrigins: blockedText.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    const res = await send({ type: 'saveSettings', settings: next });
    if (res.ok) { setSettings(next); setNotice('Settings saved.'); }
    else setError(!res.ok ? res.error : 'Could not save settings.');
  };

  const changePassphrase = async () => {
    setError(''); setNotice('');
    if (newPass.length < 8) { setError('New passphrase must be at least 8 characters.'); return; }
    if (newPass !== newPassConfirm) { setError('New passphrases do not match.'); return; }
    const res = await send({ type: 'changePassphrase', oldPassphrase: oldPass, newPassphrase: newPass });
    if (res.ok && 'changed' in res && res.changed) {
      setNotice('Passphrase changed. Your items were not re-encrypted (same master key, new wrap).');
      setOldPass(''); setNewPass(''); setNewPassConfirm('');
    } else {
      setError(res.ok && 'error' in res && res.error ? res.error : 'Could not change passphrase.');
    }
  };

  const exportEncrypted = async () => {
    const res = await send({ type: 'exportEncrypted' });
    if (res.ok && 'json' in res) {
      const blob = new Blob([res.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-secrect-extension-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice('Encrypted backup downloaded. It stays encrypted — keep it safe.');
    } else {
      setError(!res.ok ? res.error : 'Export failed. Unlock the vault first.');
    }
  };

  const wipe = async () => {
    if (wipeConfirm.trim().toUpperCase() !== 'DELETE') { setError('Type DELETE to confirm wiping the vault.'); return; }
    const res = await send({ type: 'wipeVault' });
    if (res.ok) { setNotice('Vault wiped. Reload the extension to create a new one.'); setWipeConfirm(''); }
    else setError(!res.ok ? res.error : 'Wipe failed.');
  };

  if (!loaded) return <div className="p-6 text-sm text-zinc-400">Loading settings…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">my-secrect — Settings</h1>
        <p className="mt-1 text-sm text-zinc-400">Extension settings. The vault itself lives only in the background service worker's memory while unlocked.</p>
      </header>
      {notice && <p className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" role="status">{notice}</p>}
      {error && <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300" role="alert">{error}</p>}

      <RestoreBackupExt vaultExists={vaultExists} onRestored={() => setVaultExists(true)} />

      <section className="card space-y-4" aria-label="Autofill settings">
        <h2 className="font-semibold">Autofill</h2>
        <div>
          <label className="label" htmlFor="autolock">Auto-lock after</label>
          <select id="autolock" name="autolock" className="input" value={settings.autoLockMinutes} onChange={(e) => setSettings({ ...settings, autoLockMinutes: Number(e.target.value) as AutoLockMinutes })}>
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={0}>Never</option>
          </select>
        </div>
        <label className="flex items-start gap-2 text-sm text-zinc-200">
          <input id="confirm-bank" name="confirm-bank" type="checkbox" checked={settings.requireConfirmForBank} onChange={(e) => setSettings({ ...settings, requireConfirmForBank: e.target.checked })} className="mt-1 accent-indigo-600" />
          Require confirmation before filling bank / card items
        </label>
        <label className="flex items-start gap-2 text-sm text-zinc-200">
          <input id="confirm-punycode" name="confirm-punycode" type="checkbox" checked={settings.requireConfirmForPunycode} onChange={(e) => setSettings({ ...settings, requireConfirmForPunycode: e.target.checked })} className="mt-1 accent-indigo-600" />
          Require confirmation before filling punycode (xn--) domains — homograph protection
        </label>
        <div>
          <label className="label" htmlFor="allowed-origins">Allowed origins (one per line; empty = all HTTPS sites, subject to domain match)</label>
          <textarea id="allowed-origins" name="allowed-origins" className="input font-mono" rows={3} value={allowedText} onChange={(e) => setAllowedText(e.target.value)} placeholder={'https://example.com'} />
        </div>
        <div>
          <label className="label" htmlFor="blocked-origins">Blocked origins (one per line; blocked always wins)</label>
          <textarea id="blocked-origins" name="blocked-origins" className="input font-mono" rows={3} value={blockedText} onChange={(e) => setBlockedText(e.target.value)} placeholder={'https://suspicious.example'} />
        </div>
        <button className="btn" onClick={() => void save()}>Save settings</button>
      </section>

      <section className="card space-y-3" aria-label="Change passphrase">
        <h2 className="font-semibold">Change master passphrase</h2>
        {locked ? (
          <p className="text-sm text-zinc-400">Unlock the vault in the popup first, then come back here.</p>
        ) : (
          <>
            <div><label className="label" htmlFor="old-pass">Current passphrase</label><input id="old-pass" name="old-passphrase" type="password" className="input" value={oldPass} onChange={(e) => setOldPass(e.target.value)} autoComplete="current-password" /></div>
            <div><label className="label" htmlFor="new-pass">New passphrase</label><input id="new-pass" name="new-passphrase" type="password" className="input" value={newPass} onChange={(e) => setNewPass(e.target.value)} autoComplete="new-password" /></div>
            <div><label className="label" htmlFor="new-pass-confirm">Confirm new passphrase</label><input id="new-pass-confirm" name="confirm-new-passphrase" type="password" className="input" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} autoComplete="new-password" /></div>
            <button className="btn" onClick={() => void changePassphrase()}>Change passphrase</button>
          </>
        )}
      </section>

      <section className="card space-y-3" aria-label="Backup and danger zone">
        <h2 className="font-semibold">Backup &amp; danger zone</h2>
        <p className="text-sm text-zinc-400">Export is encrypted-only. There is no plaintext export from the extension.</p>
        <div><button className="btn-secondary" onClick={() => void exportEncrypted()}>Download encrypted backup</button></div>
        <div>
          <label className="label" htmlFor="wipe-confirm">Wipe vault — type DELETE to confirm. This cannot be undone.</label>
          <input id="wipe-confirm" name="wipe-confirm" type="text" className="input font-mono" value={wipeConfirm} onChange={(e) => setWipeConfirm(e.target.value)} placeholder="DELETE" autoComplete="off" />
          <button className="btn-danger mt-2" onClick={() => void wipe()}>Wipe vault permanently</button>
        </div>
      </section>

      <section className="card space-y-2 text-sm text-zinc-400" aria-label="About">
        <h2 className="font-semibold text-zinc-100">About this extension</h2>
        <p>Local-first, end-to-end encrypted. Crypto: Argon2id + XChaCha20-Poly1305 via libsodium. The extension vault is separate from the desktop app vault until sync lands — items saved here do not appear on desktop yet.</p>
        <p>Permissions: storage, activeTab, scripting, alarms. No broad host permissions — the content script is injected on demand into the active tab only, for one user-chosen fill.</p>
        <p>Not audited, not production-ready. Do not store secrets you cannot afford to lose.</p>
      </section>
    </div>
  );
}
