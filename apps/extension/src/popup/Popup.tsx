import { useCallback, useEffect, useState } from 'react';
import type { ExtRequest, ExtResponse, LoginMeta, ItemMeta, HealthSummary, PendingForm, SaveOffer } from '../lib/messages';
import type { VaultItem } from '../../../../packages/core/src/types';
import { generateTotp } from '../lib/totp';

/**
 * Popup UI. It holds NO keys and NO vault: every sensitive operation goes
 * to the background service worker via chrome.runtime messages. The only
 * plaintext it ever holds is the single item the user opened, and the
 * single credential being copied/filled — both cleared when the popup closes.
 */

function send(req: ExtRequest): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res as ExtResponse);
    });
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function passphraseScore(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return { score, label: score <= 2 ? 'Weak' : score <= 4 ? 'Fair' : score === 5 ? 'Strong' : 'Very strong' };
}

type Screen = 'loading' | 'onboarding' | 'locked' | 'unlocked';

export default function Popup() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tabOrigin, setTabOrigin] = useState('');
  const [tabUrl, setTabUrl] = useState('');
  const [logins, setLogins] = useState<LoginMeta[]>([]);
  const [items, setItems] = useState<ItemMeta[]>([]);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [pendingForm, setPendingForm] = useState<PendingForm | null>(null);
  const [saveOffer, setSaveOffer] = useState<SaveOffer | null>(null);
  const [armed, setArmed] = useState(false);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<VaultItem | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [totpLeft, setTotpLeft] = useState(0);
  const [showAddLogin, setShowAddLogin] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [genLength, setGenLength] = useState(16);
  const [genSymbols, setGenSymbols] = useState(true);
  const [generated, setGenerated] = useState('');
  const [fillConfirm, setFillConfirm] = useState<{ id: string; reason: string } | null>(null);
  const [copied, setCopied] = useState('');

  // Onboarding / lock form state — every input has id + name + label.
  const [passphrase, setPassphrase] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  // Add-login form state.
  const [addTitle, setAddTitle] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addUrl, setAddUrl] = useState('');

  const refreshUnlocked = useCallback(async () => {
    const [tabs] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs?.url ?? '';
    setTabUrl(url);
    let origin = '';
    try { origin = new URL(url).origin; } catch { origin = ''; }
    setTabOrigin(origin);
    const [loginsRes, allRes, healthRes, pendingRes, offerRes] = await Promise.all([
      send({ type: 'listLogins', origin }),
      send({ type: 'listAll' }),
      send({ type: 'getHealth' }),
      send({ type: 'getPendingForm' }),
      send({ type: 'getSaveOffer' }),
    ]);
    if (loginsRes.ok && 'logins' in loginsRes) setLogins(loginsRes.logins);
    if (allRes.ok && 'items' in allRes) setItems(allRes.items);
    if (healthRes.ok && 'health' in healthRes) setHealth(healthRes.health);
    if (pendingRes.ok && 'pending' in pendingRes) setPendingForm(pendingRes.pending);
    if (offerRes.ok && 'offer' in offerRes) setSaveOffer(offerRes.offer);
  }, []);

  useEffect(() => {
    send({ type: 'getStatus' })
      .then((res) => {
        if (!res.ok || !('status' in res)) { setScreen('locked'); return; }
        // Opening the popup grants activeTab for this tab: let the background
        // watch for a login submission here so it can offer to save it.
        if (res.status.vaultExists) {
          void send({ type: 'armActiveTab' }).then((r) => setArmed(r.ok && 'armed' in r && r.armed)).catch(() => undefined);
        }
        if (!res.status.vaultExists) setScreen('onboarding');
        else if (res.status.locked) setScreen('locked');
        else { setScreen('unlocked'); void refreshUnlocked(); }
      })
      .catch(() => setScreen('locked'));
  }, [refreshUnlocked]);

  // Live TOTP for the open detail item.
  useEffect(() => {
    const secret = (detail?.fields as Record<string, unknown> | undefined)?.['totp_secret'];
    if (!detail || typeof secret !== 'string' || !secret) { setTotp(''); return; }
    let alive = true;
    const tick = () => {
      void generateTotp(secret).then((r) => {
        if (alive) { setTotp(r.code); setTotpLeft(r.secondsRemaining); }
      });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [detail]);

  const handleUnlock = async () => {
    setError('');
    const res = await send(useRecovery ? { type: 'unlockRecovery', recoveryKey: recoveryInput.trim() } : { type: 'unlock', passphrase });
    if (res.ok && 'unlocked' in res && res.unlocked) {
      setPassphrase(''); setRecoveryInput(''); setUseRecovery(false);
      setScreen('unlocked'); void refreshUnlocked();
    } else {
      setError(res.ok && 'error' in res && res.error ? res.error : 'Could not unlock. Check the passphrase or recovery key.');
    }
  };

  const handleCreateVault = async () => {
    setError('');
    if (newPass.length < 8) { setError('Passphrase must be at least 8 characters.'); return; }
    if (newPass !== newPassConfirm) { setError('Passphrases do not match.'); return; }
    const res = await send({ type: 'createVault', passphrase: newPass });
    if (res.ok && 'recoveryKey' in res) {
      setRecoveryKey(res.recoveryKey); setNewPass(''); setNewPassConfirm(''); setOnboardingStep(1);
    } else {
      setError(res.ok ? 'Could not create the vault.' : res.error);
    }
  };

  const handleLock = async () => {
    await send({ type: 'lock' });
    setDetail(null); setLogins([]); setItems([]); setHealth(null); setScreen('locked');
  };

  const handleFill = async (id: string, confirmed = false) => {
    setError(''); setNotice('');
    const res = await send({ type: 'fill', id, confirmed });
    if (res.ok && 'filled' in res && res.filled) {
      setNotice('Filled on this page.'); setFillConfirm(null);
    } else if (!res.ok && res.needsConfirmation) {
      setFillConfirm({ id, reason: res.needsConfirmation });
    } else {
      setError(!res.ok ? res.error : 'Fill failed.');
    }
  };

  const handleCopy = async (label: string, text: string) => {
    if (await copyText(text)) { setCopied(label); window.setTimeout(() => setCopied(''), 1500); }
  };

  const handleSaveLogin = async () => {
    setError('');
    if (!addUsername.trim() || !addPassword) { setError('Username and password are required.'); return; }
    const now = new Date().toISOString();
    const item: VaultItem = {
      id: crypto.randomUUID(), type: 'login', schema_version: 1,
      title: addTitle.trim() || addUrl || addUsername.trim(),
      fields: { username: addUsername.trim(), password: addPassword, url: addUrl.trim() || tabOrigin },
      tags: [], relations: [], attachments: [], created_at: now, updated_at: now,
    };
    const res = await send({ type: 'saveLogin', item });
    if (res.ok) {
      setShowAddLogin(false); setAddTitle(''); setAddUsername(''); setAddPassword(''); setAddUrl('');
      setNotice('Login saved.'); void refreshUnlocked();
    } else {
      setError(!res.ok ? res.error : 'Could not save.');
    }
  };

  const handleSaveOffer = async (accept: boolean) => {
    setError(''); setNotice('');
    const mode = saveOffer?.mode;
    const res = await send({ type: 'resolveSaveOffer', accept });
    setSaveOffer(null);
    if (res.ok && 'saved' in res) {
      if (res.saved) { setNotice(mode === 'update' ? 'Password updated.' : 'Login saved.'); void refreshUnlocked(); }
    } else {
      setError(!res.ok ? res.error : 'Could not save.');
    }
  };

  const handleGenerate = async () => {
    const res = await send({ type: 'generatePassword', length: genLength, symbols: genSymbols, numbers: true });
    if (res.ok && 'password' in res) { setGenerated(res.password); void copyText(res.password); }
  };

  const openDetail = async (id: string) => {
    const res = await send({ type: 'getItem', id });
    if (res.ok && 'item' in res && res.item) { setDetail(res.item); setShowPassword(false); }
  };

  const filteredItems = items.filter((i) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (i.title + ' ' + i.type + ' ' + i.tags.join(' ')).toLowerCase().includes(q);
  });

  if (screen === 'loading') {
    return <div className="p-4 text-sm text-zinc-400">Loading my-secrect…</div>;
  }

  // ---------- Onboarding ----------
  if (screen === 'onboarding') {
    const strength = passphraseScore(newPass);
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">my-secrect</h1>
        <p className="mt-1 text-xs text-zinc-400">Create your local vault. Everything is encrypted on this device; the extension never sends your vault anywhere.</p>
        <div className="mt-3 flex gap-1 text-[11px]">
          {['Create passphrase', 'Save recovery key', 'Done'].map((label, i) => (
            <span key={label} className={`flex-1 rounded-md px-1 py-1 text-center ${i === onboardingStep ? 'bg-indigo-600/25 text-indigo-200' : 'bg-zinc-900 text-zinc-500'}`}>{i + 1}. {label}</span>
          ))}
        </div>
        {onboardingStep === 0 && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="label" htmlFor="new-pass">Master passphrase</label>
              <input id="new-pass" name="master-passphrase" type="password" className="input" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
            </div>
            <div>
              <label className="label" htmlFor="new-pass-confirm">Confirm passphrase</label>
              <input id="new-pass-confirm" name="confirm-passphrase" type="password" className="input" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder="Repeat your passphrase" autoComplete="new-password" />
            </div>
            <div>
              <div className="flex justify-between text-xs"><span className="text-zinc-400">Strength</span><span className="text-zinc-200">{newPass ? strength.label : '—'}</span></div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-800"><div className={`h-full rounded-full ${strength.score <= 2 ? 'bg-red-500' : strength.score <= 4 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${(strength.score / 6) * 100}%` }} /></div>
            </div>
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
            <button className="btn w-full" onClick={() => void handleCreateVault()}>Create vault</button>
            <button className="btn-secondary w-full" onClick={() => { void chrome.runtime.openOptionsPage(); }}>Restore from backup…</button>
          </div>
        )}
        {onboardingStep === 1 && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-zinc-300"><strong>Save this recovery key — it is shown only once.</strong> It is the only way back in if you forget your passphrase.</p>
            <div className="break-all rounded-lg border border-zinc-700 bg-zinc-900 p-3 font-mono text-xs text-zinc-100">{recoveryKey}</div>
            <button className="btn-secondary w-full" onClick={() => { void copyText(recoveryKey); setRecoveryCopied(true); }}>{recoveryCopied ? 'Copied to clipboard' : 'Copy recovery key'}</button>
            <label className="flex items-start gap-2 text-sm text-zinc-200">
              <input id="recovery-ack" name="recovery-ack" type="checkbox" checked={recoveryAck} onChange={(e) => setRecoveryAck(e.target.checked)} className="mt-1 accent-indigo-600" />
              I have saved my recovery key somewhere safe.
            </label>
            <button className="btn w-full" disabled={!recoveryAck} onClick={() => setOnboardingStep(2)}>Done</button>
          </div>
        )}
        {onboardingStep === 2 && (
          <div className="mt-4 space-y-3 text-center">
            <p className="text-2xl">✓</p>
            <p className="text-sm text-zinc-300">Your vault is created and unlocked.</p>
            <button className="btn w-full" onClick={() => { setScreen('unlocked'); void refreshUnlocked(); }}>Open vault</button>
          </div>
        )}
        <p className="mt-4 text-[11px] text-zinc-500">Argon2id + XChaCha20-Poly1305 via libsodium. Not audited — do not treat as production-ready. This extension vault is separate from the desktop app until sync lands.</p>
      </div>
    );
  }

  // ---------- Lock screen ----------
  if (screen === 'locked') {
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">my-secrect</h1>
        <p className="mt-1 text-sm text-zinc-400">Your vault is locked. Enter your passphrase to unlock.</p>
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void handleUnlock(); }}>
          {useRecovery ? (
            <div>
              <label className="label" htmlFor="recovery-key">Recovery key</label>
              <input id="recovery-key" name="recovery-key" type="text" className="input font-mono" value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} placeholder="Paste your recovery key" autoComplete="off" autoFocus />
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="master-passphrase">Master passphrase</label>
              <input id="master-passphrase" name="master-passphrase" type="password" className="input" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Master passphrase" autoComplete="current-password" autoFocus />
            </div>
          )}
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          <button type="submit" className="btn w-full">{useRecovery ? 'Unlock with recovery key' : 'Unlock'}</button>
        </form>
        <button className="mt-3 w-full text-center text-sm text-indigo-300 hover:text-indigo-200" onClick={() => { setUseRecovery((v) => !v); setError(''); }}>
          {useRecovery ? 'Use passphrase instead…' : 'Unlock with a recovery key…'}
        </button>
      </div>
    );
  }

  // ---------- Unlocked ----------
  const detailFields = (detail?.fields ?? {}) as Record<string, unknown>;
  const detailPassword = typeof detailFields['password'] === 'string' ? detailFields['password'] : '';
  const detailUsername = typeof detailFields['username'] === 'string' ? detailFields['username'] : '';
  return (
    <div className="flex max-h-[600px] flex-col p-3">
      <header className="flex items-center gap-2 px-1 pb-2">
        <h1 className="text-base font-semibold">my-secrect</h1>
        <span className="chip">Unlocked</span>
        <div className="ml-auto flex gap-1">
          <button className="btn-secondary !px-2 !py-1 text-xs" onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
          <button className="btn-secondary !px-2 !py-1 text-xs" onClick={() => void handleLock()}>Lock</button>
        </div>
      </header>
      {health && (
        <p className="px-1 pb-2 text-xs text-zinc-400">Health score <strong className="text-zinc-100">{health.score}/100</strong> · {health.weakCount} weak · {health.reusedCount} reused groups · {health.total} items</p>
      )}
      {notice && <p className="mb-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" role="status">{notice}</p>}
      {error && <p className="mb-2 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300" role="alert">{error}</p>}
      {fillConfirm && (
        <div className="mb-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200" role="alert">
          <p>{fillConfirm.reason}</p>
          <div className="mt-2 flex gap-2">
            <button className="btn !py-1 text-xs" onClick={() => void handleFill(fillConfirm.id, true)}>Fill anyway</button>
            <button className="btn-secondary !py-1 text-xs" onClick={() => setFillConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {saveOffer && (
        <section aria-label="Save login offer" className="mb-2 rounded-lg border border-indigo-900/60 bg-indigo-950/40 px-3 py-2 text-sm text-indigo-100">
          {saveOffer.mode === 'update' ? (
            <p>Update the saved password for <strong>{saveOffer.title}</strong> ({saveOffer.username}) with the one you just used on <span className="font-mono text-xs">{saveOffer.origin}</span>?</p>
          ) : (
            <p>Save the login you just used on <span className="font-mono text-xs">{saveOffer.origin}</span> ({saveOffer.username})?</p>
          )}
          <p className="mt-1 text-xs text-indigo-300">Encrypted in this extension only. Nothing is saved unless you choose.</p>
          <div className="mt-2 flex gap-2">
            <button className="btn !py-1 text-xs" onClick={() => void handleSaveOffer(true)}>{saveOffer.mode === 'update' ? 'Update password' : 'Save this login'}</button>
            <button className="btn-secondary !py-1 text-xs" onClick={() => void handleSaveOffer(false)}>Not now</button>
          </div>
        </section>
      )}
      {pendingForm && !showAddLogin && (
        <div className="mb-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
          Login form detected on <span className="font-mono text-xs">{pendingForm.origin}</span>.
          <button className="ml-2 text-indigo-300 underline" onClick={() => { setAddUrl(pendingForm.origin); setShowAddLogin(true); }}>Add login for this site</button>
        </div>
      )}
      {tabOrigin && (
        <section aria-label="Logins for this site" className="mb-2">
          <h2 className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">For this site · {tabOrigin}</h2>
          {logins.length === 0 ? (
            <p className="px-1 text-sm text-zinc-500">No logins saved for this site yet.{armed ? ' Sign in on this page and my-secrect will offer to save it.' : ''}</p>
          ) : (
            <ul className="space-y-1">
              {logins.map((l) => (
                <li key={l.id} className="card flex items-center gap-2 !p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.title}</p>
                    <p className="truncate text-xs text-zinc-400">{l.username}{l.hasTotp ? ' · TOTP' : ''}</p>
                  </div>
                  <button className="btn !px-2 !py-1 text-xs" onClick={() => void handleFill(l.id)}>Fill</button>
                  <button className="btn-secondary !px-2 !py-1 text-xs" onClick={() => void openDetail(l.id)}>View</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="mb-2">
        <label className="label" htmlFor="popup-search">Search vault</label>
        <input id="popup-search" name="search" type="search" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, type or tag…" aria-label="Search vault" />
      </div>
      <div className="mb-2 flex gap-2">
        <button className="btn-secondary flex-1 !py-1.5 text-xs" onClick={() => { setAddUrl(tabOrigin); setShowAddLogin((v) => !v); }}>{showAddLogin ? 'Cancel' : '+ Add login'}</button>
        <button className="btn-secondary flex-1 !py-1.5 text-xs" onClick={() => setShowGenerator((v) => !v)}>{showGenerator ? 'Hide generator' : 'Generator'}</button>
      </div>
      {showGenerator && (
        <div className="card mb-2 space-y-2">
          <label className="label" htmlFor="gen-length">Length: {genLength}</label>
          <input id="gen-length" name="gen-length" type="range" min={8} max={64} value={genLength} onChange={(e) => setGenLength(Number(e.target.value))} className="w-full accent-indigo-600" />
          <label className="flex items-center gap-2 text-sm text-zinc-200"><input id="gen-symbols" name="gen-symbols" type="checkbox" checked={genSymbols} onChange={(e) => setGenSymbols(e.target.checked)} className="accent-indigo-600" /> Symbols</label>
          <button className="btn w-full !py-1.5 text-xs" onClick={() => void handleGenerate()}>Generate &amp; copy</button>
          {generated && <p className="break-all font-mono text-xs text-zinc-200">{generated} <span className="text-zinc-500">(copied)</span></p>}
        </div>
      )}
      {showAddLogin && (
        <div className="card mb-2 space-y-2">
          <div><label className="label" htmlFor="add-title">Title</label><input id="add-title" name="add-title" type="text" className="input" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder="e.g. Example Bank" /></div>
          <div><label className="label" htmlFor="add-username">Username</label><input id="add-username" name="add-username" type="text" className="input" value={addUsername} onChange={(e) => setAddUsername(e.target.value)} placeholder="Username or email" autoComplete="username" /></div>
          <div><label className="label" htmlFor="add-password">Password</label><input id="add-password" name="add-password" type="password" className="input" value={addPassword} onChange={(e) => setAddPassword(e.target.value)} placeholder="Password" autoComplete="new-password" /></div>
          <div><label className="label" htmlFor="add-url">URL</label><input id="add-url" name="add-url" type="url" className="input" value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="https://example.com" /></div>
          <button className="btn w-full !py-1.5 text-xs" onClick={() => void handleSaveLogin()}>Save login</button>
        </div>
      )}
      {detail ? (
        <section className="card mb-2 space-y-2" aria-label="Item detail">
          <div className="flex items-start justify-between gap-2">
            <div><h2 className="text-sm font-semibold">{detail.title}</h2><p className="text-xs text-zinc-400">{detail.type}{detail.favorite ? ' · ★ Favorite' : ''}</p></div>
            <button className="text-zinc-400 hover:text-zinc-100" onClick={() => setDetail(null)} aria-label="Close detail">✕</button>
          </div>
          {detailUsername && <p className="text-sm"><span className="text-zinc-400">Username: </span>{detailUsername} <button className="ml-1 text-indigo-300 underline" onClick={() => void handleCopy('username', detailUsername)}>{copied === 'username' ? 'Copied' : 'Copy'}</button></p>}
          {detailPassword && (
            <p className="text-sm"><span className="text-zinc-400">Password: </span><span className="font-mono">{showPassword ? detailPassword : '••••••••'}</span>{' '}
              <button className="text-indigo-300 underline" onClick={() => setShowPassword((v) => !v)}>{showPassword ? 'Hide' : 'Show'}</button>{' '}
              <button className="text-indigo-300 underline" onClick={() => void handleCopy('password', detailPassword)}>{copied === 'password' ? 'Copied' : 'Copy'}</button></p>
          )}
          {totp && <p className="text-sm"><span className="text-zinc-400">TOTP: </span><span className="font-mono text-base">{totp}</span> <span className="text-xs text-zinc-500">({totpLeft}s)</span> <button className="text-indigo-300 underline" onClick={() => void handleCopy('totp', totp)}>{copied === 'totp' ? 'Copied' : 'Copy'}</button></p>}
          {detail.tags.length > 0 && <p className="text-xs text-zinc-400">Tags: {detail.tags.join(', ')}</p>}
          <div className="flex gap-2">
            <button className="btn flex-1 !py-1.5 text-xs" onClick={() => void handleFill(detail.id)}>Fill on this page</button>
            <button className="btn-secondary !py-1.5 text-xs" onClick={() => { void send({ type: 'deleteItem', id: detail.id }); setDetail(null); void refreshUnlocked(); }}>Move to trash</button>
          </div>
        </section>
      ) : (
        <section aria-label="All items" className="min-h-0 flex-1 overflow-y-auto">
          <h2 className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">All items ({filteredItems.length})</h2>
          {filteredItems.length === 0 ? (
            <p className="px-1 py-4 text-center text-sm text-zinc-500">No items yet. Add a login above, or open the desktop app to add any of the 8 item types.</p>
          ) : (
            <ul className="space-y-1">
              {filteredItems.map((i) => (
                <li key={i.id}>
                  <button className="card flex w-full items-center gap-2 !p-2 text-left hover:border-zinc-600" onClick={() => void openDetail(i.id)}>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{i.title}</span><span className="block text-xs text-zinc-400">{i.type}{i.favorite ? ' · ★' : ''}</span></span>
                    <span className="text-xs text-zinc-500">View ›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="pt-2 text-center text-[11px] text-zinc-500">Full vault (8 modules, notes, media, documents) lives in the desktop app. The extension handles logins + fill.</p>
    </div>
  );
}
