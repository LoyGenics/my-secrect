import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AccountStatus, ExtRequest, ExtResponse, LoginMeta, ItemMeta, HealthSummary, PendingForm, SaveOffer } from '../lib/messages';
import type { VaultItem } from '../../../../packages/core/src/types';
import { DEFAULT_SETTINGS, type AutoLockMinutes, type Appearance, type ExtSettings } from '../lib/settings';
import { generateTotp } from '../lib/totp';
import ghostMark from '../../../../packages/ui/assets/brand/ghost-mark.webp';
import ghostSearching from '../../../../packages/ui/assets/mascot/ghost-searching.webp';
import { Icon, type IconName } from './icons';
import { Code, Colorized, Dock, Msg, OtpRing, Seg, SiteStamp, Stamp, Star, Switch, Topbar, typeLabel, type Tab } from './parts';
import { applyAppearance } from './theme';
import SignIn from './SignIn';
import { formatDate, format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';

/**
 * Popup UI. It holds NO keys and NO vault: every sensitive operation goes
 * to the background service worker via chrome.runtime messages. The only
 * plaintext it ever holds is the single item the user opened, the single
 * credential being copied/filled, and the current one-time codes of this
 * site's logins (codes only, never the TOTP secret) — all cleared when the
 * popup closes.
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

function passphraseScore(pw: string): { score: number; label: 'strengthWeak' | 'strengthFair' | 'strengthStrong' | 'strengthVeryStrong' } {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return { score, label: score <= 2 ? 'strengthWeak' : score <= 4 ? 'strengthFair' : score === 5 ? 'strengthStrong' : 'strengthVeryStrong' };
}

const hostOfUrl = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};
const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type Screen = 'loading' | 'signin' | 'onboarding' | 'locked' | 'unlocked';
type Toast = { text: string; icon: IconName; on: boolean };

export default function Popup() {
  const { dict, tp, locale } = useTranslation();
  const x = dict.extension;
  const [screen, setScreen] = useState<Screen>('loading');
  const [tab, setTab] = useState<Tab>('site');
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>({ text: '', icon: 'circle-check', on: false });
  const [settings, setSettings] = useState<ExtSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [tabUrl, setTabUrl] = useState('');
  const [tabOrigin, setTabOrigin] = useState('');
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
  const [rowCodes, setRowCodes] = useState<Record<string, string>>({});
  const [clock, setClock] = useState(() => Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [genLength, setGenLength] = useState(16);
  const [genSymbols, setGenSymbols] = useState(true);
  const [generated, setGenerated] = useState('');
  const [fillConfirm, setFillConfirm] = useState<{ id: string; reason: string } | null>(null);

  // Onboarding / lock form state — every input has id + name + label.
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [vaultExists, setVaultExists] = useState(false);
  // Add-login form state.
  const [addTitle, setAddTitle] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addUrl, setAddUrl] = useState('');

  const baseRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const toastTimer = useRef(0);
  const [focusSearch, setFocusSearch] = useState(false);

  const isWeb = /^https?:\/\//.test(tabOrigin);
  const host = isWeb ? hostOfUrl(tabUrl) : '';
  const sheetOpen = detail !== null || addOpen;

  const showToast = useCallback((text: string, icon: IconName = 'circle-check') => {
    setToast({ text, icon, on: true });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast((t) => ({ ...t, on: false })), 1800);
  }, []);

  const refreshUnlocked = useCallback(async (initial = false) => {
    const [tabs] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs?.url ?? '';
    setTabUrl(url);
    let origin = '';
    try { origin = new URL(url).origin; } catch { origin = ''; }
    setTabOrigin(origin);
    // A tab that is not a website has nothing to fill: open on All items.
    if (initial) setTab(/^https?:\/\//.test(origin) ? 'site' : 'all');
    const [loginsRes, allRes, healthRes, pendingRes, offerRes] = await Promise.all([
      send({ type: 'listLogins', origin }),
      send({ type: 'listAll' }),
      send({ type: 'getHealth' }),
      send({ type: 'getPendingForm' }),
      send({ type: 'getSaveOffer' }),
    ]);
    if (loginsRes.ok && 'logins' in loginsRes) {
      setLogins([...loginsRes.logins].sort((a, b) => Number(b.favorite) - Number(a.favorite) || byTitle(a, b)));
    }
    if (allRes.ok && 'items' in allRes) setItems(allRes.items);
    if (healthRes.ok && 'health' in healthRes) setHealth(healthRes.health);
    if (pendingRes.ok && 'pending' in pendingRes) setPendingForm(pendingRes.pending);
    if (offerRes.ok && 'offer' in offerRes) setSaveOffer(offerRes.offer);
  }, []);

  useEffect(() => {
    void send({ type: 'getSettings' })
      .then((res) => {
        if (res.ok && 'settings' in res) { setSettings(res.settings); applyAppearance(res.settings.appearance); setSettingsLoaded(true); }
      })
      .catch(() => undefined);
    Promise.all([send({ type: 'getAccount' }), send({ type: 'getStatus' })])
      .then(([acc, res]) => {
        if (acc.ok && 'account' in acc) setAccount(acc.account);
        if (!res.ok || !('status' in res)) { setScreen('locked'); return; }
        setVaultExists(res.status.vaultExists);
        // Opening the popup grants activeTab for this tab: let the background
        // watch for a login submission here so it can offer to save it.
        if (res.status.vaultExists) {
          void send({ type: 'armActiveTab' }).then((r) => setArmed(r.ok && 'armed' in r && r.armed)).catch(() => undefined);
        }
        // Account first: no vault is created or unlocked before sign-in.
        const signedIn = acc.ok && 'account' in acc && acc.account.step === 'signed-in';
        if (!res.status.locked) { setScreen('unlocked'); void refreshUnlocked(true); }
        else if (!signedIn) setScreen('signin');
        else setScreen(res.status.vaultExists ? 'locked' : 'onboarding');
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

  // Code chips on this site's rows: the background returns the code only,
  // once per 30 s window; the countdown runs here.
  const totpIds = useMemo(() => logins.filter((l) => l.hasTotp).map((l) => l.id), [logins]);
  const rowTotpActive = screen === 'unlocked' && tab === 'site' && totpIds.length > 0;
  useEffect(() => {
    if (!rowTotpActive) return;
    let alive = true;
    let lastWindow = -1;
    const tick = () => {
      const now = Date.now();
      setClock(now);
      const w = Math.floor(now / 30_000);
      if (w === lastWindow) return;
      lastWindow = w;
      void Promise.all(totpIds.map(async (id) => {
        const res = await send({ type: 'getTotpCode', id }).catch(() => null);
        return [id, res && res.ok && 'code' in res ? res.code : null] as const;
      })).then((pairs) => {
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const [id, code] of pairs) if (code) next[id] = code;
        setRowCodes(next);
      });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [rowTotpActive, totpIds]);
  const rowLeft = 30 - (Math.floor(clock / 1000) % 30);

  // Sheets: the ledger behind is inert, focus moves into the sheet and back.
  useEffect(() => {
    if (baseRef.current) baseRef.current.inert = sheetOpen;
    if (sheetOpen) sheetRef.current?.focus();
  }, [sheetOpen]);

  useEffect(() => {
    if (focusSearch && tab === 'all') { searchRef.current?.focus(); setFocusSearch(false); }
  }, [focusSearch, tab]);

  const closeSheet = () => {
    setDetail(null); setShowPassword(false); setAddOpen(false);
    const back = openerRef.current;
    openerRef.current = null;
    window.requestAnimationFrame(() => { if (back?.isConnected) back.focus(); });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && sheetOpen) { e.preventDefault(); closeSheet(); }
  };

  const goTab = (t: Tab) => { setTab(t); setError(''); setFillConfirm(null); };

  const copy = async (text: string, done: string) => {
    if (await copyText(text)) showToast(done, 'copy');
    else setError(x.copyFailed);
  };

  /** The background refused because the account session is gone: back to sign-in. */
  const toSignIn = async () => {
    const acc = await send({ type: 'getAccount' });
    if (acc.ok && 'account' in acc) setAccount(acc.account);
    setError(''); setScreen('signin');
  };

  const onAccount = (next: AccountStatus) => {
    setAccount(next);
    if (next.step === 'signed-in') { setError(''); setScreen(vaultExists ? 'locked' : 'onboarding'); }
  };

  const handleSignOut = async () => {
    const res = await send({ type: 'signOut' });
    setDetail(null); setAddOpen(false); setLogins([]); setItems([]); setHealth(null); setRowCodes({});
    setSaveOffer(null); setGenerated(''); setQuery(''); setFillConfirm(null); setError('');
    if (res.ok && 'account' in res) setAccount(res.account);
    setScreen('signin');
    showToast(x.signedOutToast, 'lock');
  };

  const handleUnlock = async () => {
    setError('');
    const value = useRecovery ? recoveryInput.trim() : passphrase;
    if (!value) { setError(useRecovery ? x.pasteRecoveryKey : x.enterPassphrase); passRef.current?.focus(); return; }
    const res = await send(useRecovery ? { type: 'unlockRecovery', recoveryKey: value } : { type: 'unlock', passphrase });
    if (!res.ok && res.authError === 'signed-out') { await toSignIn(); return; }
    if (res.ok && 'unlocked' in res && res.unlocked) {
      setPassphrase(''); setRecoveryInput(''); setUseRecovery(false); setShowPass(false);
      setScreen('unlocked'); void refreshUnlocked(true);
    } else {
      setError(res.ok && 'error' in res && res.error ? res.error : x.unlockFailed);
      passRef.current?.focus();
    }
  };

  const handleCreateVault = async () => {
    setError('');
    if (newPass.length < 8) { setError(x.passphraseTooShort); return; }
    if (newPass !== newPassConfirm) { setError(x.passphraseMismatch); return; }
    const res = await send({ type: 'createVault', passphrase: newPass });
    if (!res.ok && res.authError === 'signed-out') { await toSignIn(); return; }
    if (res.ok && 'recoveryKey' in res) {
      setRecoveryKey(res.recoveryKey); setNewPass(''); setNewPassConfirm(''); setOnboardingStep(1); setVaultExists(true);
    } else {
      setError(res.ok ? x.createFailed : res.error);
    }
  };

  const handleLock = async () => {
    await send({ type: 'lock' });
    setDetail(null); setAddOpen(false); setLogins([]); setItems([]); setHealth(null); setRowCodes({});
    setSaveOffer(null); setGenerated(''); setQuery(''); setFillConfirm(null); setError('');
    setScreen('locked');
    showToast(x.lockedToast, 'lock');
  };

  const handleFill = async (id: string, confirmed = false) => {
    setError(''); setFillConfirm(null);
    const res = await send({ type: 'fill', id, confirmed });
    if (res.ok && 'filled' in res && res.filled) {
      const who = logins.find((l) => l.id === id)?.username || str(detail?.fields['username']);
      showToast(who && host ? format(x.filledAs, who, host) : x.filled);
    } else if (!res.ok && res.needsConfirmation) {
      setFillConfirm({ id, reason: res.needsConfirmation });
    } else {
      setError(!res.ok ? res.error : x.fillFailed);
    }
  };

  /** Row copy: fetch the one item, copy its password, keep nothing. */
  const copyPasswordOf = async (id: string) => {
    setError('');
    const res = await send({ type: 'getItem', id });
    const pw = res.ok && 'item' in res && res.item ? str(res.item.fields['password']) : '';
    if (pw) await copy(pw, x.passwordCopied);
    else setError(x.noPasswordToCopy);
  };

  const openAdd = (opener: HTMLElement) => {
    openerRef.current = opener;
    setError('');
    setAddUrl(pendingForm?.origin || (isWeb ? tabOrigin : ''));
    setAddOpen(true);
  };

  const handleSaveLogin = async () => {
    setError('');
    if (!addUsername.trim() || !addPassword) { setError(x.usernamePasswordRequired); return; }
    const now = new Date().toISOString();
    const item: VaultItem = {
      id: crypto.randomUUID(), type: 'login', schema_version: 1,
      title: addTitle.trim() || addUrl || addUsername.trim(),
      fields: { username: addUsername.trim(), password: addPassword, url: addUrl.trim() || tabOrigin },
      tags: [], relations: [], attachments: [], created_at: now, updated_at: now,
    };
    const res = await send({ type: 'saveLogin', item });
    if (res.ok) {
      setAddTitle(''); setAddUsername(''); setAddPassword(''); setAddUrl('');
      closeSheet();
      showToast(x.loginSaved); void refreshUnlocked();
    } else {
      setError(!res.ok ? res.error : x.saveFailed);
    }
  };

  const handleSaveOffer = async (accept: boolean) => {
    setError('');
    const mode = saveOffer?.mode;
    const res = await send({ type: 'resolveSaveOffer', accept });
    setSaveOffer(null);
    if (res.ok && 'saved' in res) {
      if (res.saved) { showToast(mode === 'update' ? x.passwordUpdated : x.loginSaved); void refreshUnlocked(); }
    } else {
      setError(!res.ok ? res.error : x.saveFailed);
    }
  };

  const generate = useCallback(async (length: number, symbols: boolean) => {
    const res = await send({ type: 'generatePassword', length, symbols, numbers: true });
    if (res.ok && 'password' in res) setGenerated(res.password);
  }, []);

  useEffect(() => {
    if (screen === 'unlocked' && tab === 'gen' && !generated) void generate(genLength, genSymbols);
  }, [screen, tab, generated, generate, genLength, genSymbols]);

  /** Re-read settings before writing so a change made on the options page is not overwritten. */
  const updateSettings = async (patch: Partial<ExtSettings>) => {
    if (!settingsLoaded) return;
    const cur = await send({ type: 'getSettings' });
    const next: ExtSettings = { ...(cur.ok && 'settings' in cur ? cur.settings : settings), ...patch };
    setSettings(next);
    if (patch.appearance) applyAppearance(next.appearance);
    const res = await send({ type: 'saveSettings', settings: next });
    if (!res.ok) setError(res.error);
  };

  const openDetail = async (id: string, opener: HTMLElement) => {
    const res = await send({ type: 'getItem', id });
    if (res.ok && 'item' in res && res.item) { openerRef.current = opener; setDetail(res.item); setShowPassword(false); setError(''); }
  };

  const handleTrash = async (id: string) => {
    const res = await send({ type: 'deleteItem', id });
    if (!res.ok) { setError(res.error); return; }
    setDetail(null); setShowPassword(false); openerRef.current = null;
    showToast(x.movedToTrash, 'trash2');
    void refreshUnlocked();
  };

  const toastEl = (nodock: boolean) => (
    <div className={`toast${toast.on ? ' on' : ''}${nodock ? ' nodock' : ''}`} role="status">
      {toast.text && <><Icon name={toast.icon} /><span>{toast.text}</span></>}
    </div>
  );

  if (screen === 'loading') return <div className="popup" />;

  // ---------- Account sign-in (before any vault screen) ----------
  if (screen === 'signin') {
    if (!account) return <div className="popup" />;
    return (
      <div className="popup">
        <section className="view lock" aria-labelledby="signin-h">
          <div className="inner">
            <img className="mark" src={ghostMark} alt="" />
            <h1 id="signin-h">{x.signInTitle}</h1>
            <p className="lede">{x.signInLede}</p>
            <SignIn account={account} onChange={onAccount} tone="cover" />
            <Msg icon="shield-check" className="oncover lockfoot">{x.cryptoNote}</Msg>
          </div>
        </section>
        {toastEl(true)}
      </div>
    );
  }

  // ---------- Onboarding ----------
  if (screen === 'onboarding') {
    const strength = passphraseScore(newPass);
    return (
      <div className="popup">
        <section className="view lock" aria-labelledby="onb-h">
          <div className="inner">
            <img className="mark sm" src={ghostMark} alt="" />
            <h1 id="onb-h">{x.createTitle}</h1>
            <p className="lede">{x.createLede}</p>
            <ol className="steps">
              {[x.passphrase, x.recoveryKey, x.done].map((label, i) => (
                <li key={label} aria-current={i === onboardingStep ? 'step' : undefined}>{i + 1}. {label}</li>
              ))}
            </ol>
            {onboardingStep === 0 && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void handleCreateVault(); }} noValidate>
                <div>
                  <label className="flabel" htmlFor="new-pass">{x.masterPassphrase}</label>
                  <div className="cfield"><input id="new-pass" name="master-passphrase" type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder={x.atLeast8} autoComplete="new-password" /></div>
                </div>
                <div>
                  <label className="flabel" htmlFor="new-pass-confirm">{x.confirmPassphrase}</label>
                  <div className="cfield"><input id="new-pass-confirm" name="confirm-passphrase" type="password" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder={x.repeatPassphrase} autoComplete="new-password" /></div>
                </div>
                <div>
                  <p className="msg oncover"><span>{format(x.strength, newPass ? x[strength.label] : '—')}</span></p>
                  <div className="meter" aria-hidden="true"><i style={{ width: `${(strength.score / 6) * 100}%` }} /></div>
                </div>
                {error && <Msg icon="circle-alert" className="oncover err"><span role="alert">{error}</span></Msg>}
                <button className="btn lg wide btn-primary" type="submit">{x.createVault}</button>
                <Msg icon="info" className="oncover">{x.syncNote}</Msg>
                <button className="btn wide btn-quiet" type="button" onClick={() => { void chrome.runtime.openOptionsPage(); }}>{x.restoreFromBackup}</button>
              </form>
            )}
            {onboardingStep === 1 && (
              <div className="stack">
                <p className="lede" style={{ margin: 0 }}><strong>{x.recoveryShownOnce}</strong> {x.recoveryOnlyWay}</p>
                <div className="keybox" data-testid="recovery-key">{recoveryKey.match(/.{1,4}/g)?.map((g, i) => <span key={i}>{g}</span>)}</div>
                <button className="btn wide btn-quiet" type="button" onClick={() => { void copyText(recoveryKey); setRecoveryCopied(true); }}><Icon name="copy" />{recoveryCopied ? x.copiedToClipboard : x.copyRecoveryKey}</button>
                <label className="check" htmlFor="recovery-ack">
                  <input id="recovery-ack" name="recovery-ack" type="checkbox" checked={recoveryAck} onChange={(e) => setRecoveryAck(e.target.checked)} />
                  {x.recoveryAck}
                </label>
                <button className="btn lg wide btn-primary" type="button" disabled={!recoveryAck} onClick={() => setOnboardingStep(2)}>{x.done}</button>
              </div>
            )}
            {onboardingStep === 2 && (
              <div className="stack">
                <Msg icon="shield-check" className="oncover">{x.vaultCreated}</Msg>
                <button className="btn lg wide btn-primary" type="button" onClick={() => { setScreen('unlocked'); void refreshUnlocked(true); }}>{x.openVault}</button>
              </div>
            )}
            <Msg icon="info" className="oncover lockfoot">{x.cryptoNote}</Msg>
          </div>
        </section>
      </div>
    );
  }

  // ---------- Lock screen ----------
  if (screen === 'locked') {
    const lockMins = settings.autoLockMinutes;
    return (
      <div className="popup">
        <section className="view lock" aria-labelledby="lock-h">
          <div className="inner">
            <img className="mark" src={ghostMark} alt="" />
            <h1 id="lock-h">{x.unlockTitle}</h1>
            <p className="lede">{useRecovery ? x.lockLedeRecovery : x.lockLedePassphrase}</p>
            <form onSubmit={(e) => { e.preventDefault(); void handleUnlock(); }} noValidate>
              {useRecovery ? (
                <>
                  <label className="flabel" htmlFor="recovery-key">{x.recoveryKey}</label>
                  <div className={`cfield${error ? ' invalid' : ''}`}>
                    <input ref={passRef} id="recovery-key" name="recovery-key" type="text" className="mono" value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} placeholder={x.pasteRecoveryPlaceholder} autoComplete="off" autoFocus aria-invalid={error ? true : undefined} aria-describedby={error ? 'pass-err' : undefined} />
                  </div>
                </>
              ) : (
                <>
                  <label className="flabel" htmlFor="master-passphrase">{x.masterPassphrase}</label>
                  <div className={`cfield${error ? ' invalid' : ''}`}>
                    <input ref={passRef} id="master-passphrase" name="master-passphrase" type={showPass ? 'text' : 'password'} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={x.passphrase} autoComplete="current-password" autoFocus aria-invalid={error ? true : undefined} aria-describedby={error ? 'pass-err' : undefined} />
                    <button className="ib" type="button" aria-label={showPass ? x.hidePassphrase : x.showPassphrase} aria-pressed={showPass} onClick={() => setShowPass((v) => !v)}><Icon name={showPass ? 'eye-off' : 'eye'} /></button>
                  </div>
                </>
              )}
              {error && <p className="msg oncover err" id="pass-err" role="alert"><Icon name="circle-alert" /><span>{error}</span></p>}
              <button type="submit" className="btn lg wide btn-primary go">{useRecovery ? x.unlockWithRecovery : x.unlock}</button>
            </form>
            <button className="btn-link alt" type="button" onClick={() => { setUseRecovery((v) => !v); setError(''); }}>
              {useRecovery ? x.usePassphraseInstead : x.useRecoveryInstead}
            </button>
            <Msg icon="timer" className="oncover lockfoot">
              {lockMins ? tp(x.locksAfter, lockMins) : x.staysUnlocked}
            </Msg>
            <p className="msg oncover" data-testid="signed-in-as">
              <span>{account?.email ? format(x.signedInAs, account.email) : x.signedIn}</span>
              <button className="btn-link alt" type="button" style={{ marginTop: 0 }} onClick={() => void handleSignOut()}>{x.signOut}</button>
            </p>
          </div>
        </section>
        {toastEl(true)}
      </div>
    );
  }

  // ---------- Unlocked ----------
  const detailFields = (detail?.fields ?? {}) as Record<string, unknown>;
  const detailPassword = str(detailFields['password']);
  const detailUsername = str(detailFields['username']);
  const detailUrl = str(detailFields['url']);
  const q = query.trim().toLowerCase();
  const filteredItems = items
    .filter((i) => !q || `${i.title} ${i.type} ${typeLabel(dict, i.type)} ${i.tags.join(' ')}`.toLowerCase().includes(q))
    .sort(byTitle);
  const nodock = saveOffer !== null || sheetOpen;

  const addButton = (
    <button className="btn btn-primary" type="button" onClick={(e) => openAdd(e.currentTarget)}><Icon name="plus" />{x.addLogin}</button>
  );

  const siteBody = !isWeb ? (
    <div className="empty">
      <img src={ghostSearching} alt="" />
      <h2>{x.noWebsiteTitle}</h2>
      <p>{x.noWebsiteBody}</p>
      {addButton}
    </div>
  ) : logins.length === 0 ? (
    <div className="empty">
      <img src={ghostSearching} alt="" />
      <h2>{x.nothingSavedTitle}</h2>
      <p>{armed ? x.nothingSavedArmed : x.nothingSaved}</p>
      {addButton}
    </div>
  ) : (
    <>
      <div className="secline"><span>{tp(x.savedLogins, logins.length)}</span></div>
      <ul className="ledger" aria-label={format(x.loginsFor, host)}>
        {logins.map((l, idx) => {
          const code = rowCodes[l.id];
          return (
            <li key={l.id} className={`lrow${code ? ' has-otp' : ''}`}>
              <button className="main" type="button" aria-label={format(x.rowLabel, l.title, l.username, l.favorite ? x.favoriteSr : '')} onClick={(e) => void openDetail(l.id, e.currentTarget)}>
                <Stamp type="login" />
                <span className="txt"><span className="t"><span>{l.title}</span>{l.favorite && <Icon name="star" className="star" />}</span><span className="s">{l.username}</span></span>
              </button>
              <span className="acts">
                <button className={`btn sm ${idx === 0 ? 'btn-primary' : 'btn-quiet'}`} type="button" aria-label={format(x.fillAria, l.title)} onClick={() => void handleFill(l.id)}>{x.fill}</button>
                <button className="ib" type="button" aria-label={format(x.copyPasswordFor, l.title)} onClick={() => void copyPasswordOf(l.id)}><Icon name="copy" /></button>
              </span>
              {code && (
                <button className="otp" type="button" aria-label={format(x.copyCodeFor, l.title)} onClick={() => void copy(code, x.codeCopied)}>
                  <OtpRing left={rowLeft} /><span className="code"><Code code={code} /></span><span className="left">{format(x.secondsLeft, rowLeft)}</span><Icon name="copy" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button className="btn-link addrow" type="button" onClick={(e) => openAdd(e.currentTarget)}><Icon name="plus" />{x.addAnother}</button>
      {health && (
        <p className="health"><Icon name="shield-check" /><span>{x.healthLabel} <b>{health.score}/100</b> · {format(x.healthRest, health.weakCount, health.reusedCount)}</span></p>
      )}
    </>
  );

  let lastLetter = '';
  const allBody = items.length === 0 ? (
    <div className="empty">
      <img src={ghostSearching} alt="" />
      <h2>{x.emptyVaultTitle}</h2>
      <p>{x.emptyVaultBody}</p>
      {addButton}
    </div>
  ) : (
    <>
      <div className="secline"><span>{q ? format(x.itemsOf, filteredItems.length, items.length) : tp(x.itemsCount, items.length)}</span><span>{x.sortTitle}</span></div>
      {filteredItems.length === 0 ? (
        <div className="empty"><h2>{x.noMatches}</h2><p>{format(x.noMatchesBody, query.trim())}</p></div>
      ) : (
        <ul className="ledger az" aria-label={x.itemsAria}>
          {filteredItems.map((i) => {
            const first = i.title.trim()[0] ?? '';
            const letter = /[a-z]/i.test(first) ? first.toUpperCase() : '#';
            const showLetter = letter !== lastLetter;
            lastLetter = letter;
            return (
              <li key={i.id} className="lrow" data-letter={showLetter ? letter : undefined}>
                <button className="main" type="button" aria-label={format(x.rowLabel, i.title, typeLabel(dict, i.type), i.favorite ? x.favoriteSr : '')} onClick={(e) => void openDetail(i.id, e.currentTarget)}>
                  <Stamp type={i.type} />
                  <span className="txt"><span className="t"><span>{i.title}</span>{i.favorite && <Icon name="star" className="star" />}</span><span className="s">{typeLabel(dict, i.type)}{i.tags.length ? ` · ${i.tags.join(', ')}` : ''}</span></span>
                </button>
                <span className="acts">
                  {i.type === 'login' && <button className="ib" type="button" aria-label={format(x.copyPasswordFor, i.title)} onClick={() => void copyPasswordOf(i.id)}><Icon name="copy" /></button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  const genPct = ((genLength - 8) / (64 - 8)) * 100;
  const regen = (length = genLength, symbols = genSymbols) => void generate(length, symbols);

  const views: Record<Tab, { label: string; cover: JSX.Element; body: JSX.Element; foot?: JSX.Element }> = {
    site: {
      label: x.thisSite,
      cover: (
        <>
          <div className="site">
            <SiteStamp host={host || '?'} />
            <div className="txt"><h1>{host || x.noWebsite}</h1><p>{x.currentTab}</p></div>
          </div>
          <button className="csearch" type="button" onClick={() => { goTab('all'); setFocusSearch(true); }}><Icon name="search" /><span>{x.searchAll}</span></button>
        </>
      ),
      body: siteBody,
    },
    all: {
      label: x.allItems,
      cover: (
        <>
          <div className="chead"><h1>{x.allItems}</h1></div>
          <div className="csearch">
            <Icon name="search" />
            <input ref={searchRef} id="popup-search" name="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={x.searchPlaceholder} aria-label={x.searchAll} autoComplete="off" />
            {query && <button className="clear" type="button" aria-label={x.clearSearch} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><Icon name="x" /></button>}
          </div>
        </>
      ),
      body: allBody,
    },
    gen: {
      label: x.generate,
      cover: <div className="chead"><h1>{x.generate}</h1></div>,
      body: (
        <div className="gen">
          <div className="genout"><p className="mono" aria-live="polite" aria-label={x.generatedPassword}>{generated ? <Colorized text={generated} /> : ' '}</p></div>
          <p className="gensub">{format(genSymbols ? x.genSummary : x.genSummaryNoSymbols, genLength)}</p>
          <div className="rangewrap">
            <div className="rangehead"><label className="k" htmlFor="gen-length">{x.length}</label><span className="n">{genLength}</span></div>
            <input id="gen-length" name="gen-length" type="range" min={8} max={64} value={genLength} style={{ '--fill': `${genPct.toFixed(1)}%` } as CSSProperties} onChange={(e) => { const n = Number(e.target.value); setGenLength(n); regen(n); }} />
          </div>
          <Switch label={x.symbols} checked={genSymbols} onChange={(v) => { setGenSymbols(v); regen(genLength, v); }} />
          <div className="setrow"><span className="k">{x.numbers}</span><span className="v">{x.alwaysIncluded}</span></div>
        </div>
      ),
      foot: (
        <div className="genfoot">
          <button className="btn btn-quiet" type="button" onClick={() => regen()}><Icon name="refresh-cw" />{x.regenerate}</button>
          <button className="btn btn-primary" type="button" disabled={!generated} onClick={() => void copy(generated, x.passwordCopied)}><Icon name="copy" />{x.copyPassword}</button>
        </div>
      ),
    },
    settings: {
      label: x.settings,
      cover: <div className="chead"><h1>{x.settings}</h1></div>,
      body: (
        <div className="set">
          <h2>{x.autoLockAfter}</h2>
          <Seg<AutoLockMinutes> label={x.autoLock} value={settings.autoLockMinutes} disabled={!settingsLoaded}
            options={[[1, format(x.minutesShort, 1)], [5, format(x.minutesShort, 5)], [15, format(x.minutesShort, 15)], [0, x.never]]} onChange={(v) => void updateSettings({ autoLockMinutes: v })} />
          <h2>{x.appearance}</h2>
          <Seg<Appearance> label={x.appearance} value={settings.appearance} disabled={!settingsLoaded}
            options={[['system', x.system, 'monitor'], ['light', x.light, 'sun'], ['dark', x.dark, 'moon']]} onChange={(v) => void updateSettings({ appearance: v })} />
          <h2>{x.beforeFilling}</h2>
          <Switch label={x.confirmBank} checked={settings.requireConfirmForBank} disabled={!settingsLoaded} onChange={(v) => void updateSettings({ requireConfirmForBank: v })} />
          <Switch label={x.confirmPunycode} checked={settings.requireConfirmForPunycode} disabled={!settingsLoaded} onChange={(v) => void updateSettings({ requireConfirmForPunycode: v })} />
          <button className="linkrow" type="button" onClick={() => { void chrome.runtime.openOptionsPage(); }}>
            <span className="txt"><span className="k">{x.allSettings}</span><span className="h">{x.allSettingsHint}</span></span><Icon name="external-link" />
          </button>
          <h2>{x.account}</h2>
          <div className="setrow"><span className="k">{account?.email ? format(x.signedInAs, account.email) : x.signedIn}</span>
            <button className="btn sm btn-quiet" type="button" onClick={() => void handleSignOut()}>{x.signOut}</button></div>
          <Msg icon="info">{x.noSyncNote}</Msg>
        </div>
      ),
    },
  };
  const view = views[tab];

  return (
    <div className="popup" onKeyDown={onKeyDown}>
      {saveOffer ? (
        <section className="view" aria-label={x.saveOfferRegion}>
          <header className="cover">
            <Topbar onLock={() => void handleLock()} />
            <div className="site">
              <SiteStamp host={hostOfUrl(saveOffer.origin)} />
              <div className="txt"><h1>{hostOfUrl(saveOffer.origin)}</h1><p>{x.justSignedIn}</p></div>
            </div>
          </header>
          <div className="scroll">
            <div className="offer">
              <h2>{saveOffer.mode === 'update' ? x.updateTitle : x.saveTitle}</h2>
              <p className="lede">{saveOffer.mode === 'update' ? format(x.updateLede, saveOffer.title) : x.saveLede}</p>
              <div className="drow"><span className="lab">{x.website}</span><span className="val">{saveOffer.origin}</span><span /></div>
              <div className="drow"><span className="lab">{x.username}</span><span className="val">{saveOffer.username}</span><span /></div>
              <div className="drow"><span className="lab">{x.password}</span><span className="val held"><Icon name="lock-keyhole" /><span>{x.heldByExtension}</span></span><span /></div>
              <Msg icon="shield-check">{x.encryptedHere}</Msg>
            </div>
          </div>
          <div className="offerfoot">
            <button className="btn btn-quiet" type="button" onClick={() => void handleSaveOffer(false)}>{x.notNow}</button>
            <button className="btn btn-primary" type="button" onClick={() => void handleSaveOffer(true)}>{saveOffer.mode === 'update' ? x.updatePassword : x.saveThisLogin}</button>
          </div>
        </section>
      ) : (
        <section className="view" aria-label={view.label} ref={baseRef}>
          <header className="cover">
            <Topbar onLock={() => void handleLock()} />
            {view.cover}
          </header>
          <div className={`scroll${view.foot ? '' : ' withdock'}`}>{view.body}</div>
          {view.foot}
          <Dock tab={tab} onTab={goTab} />
        </section>
      )}

      {detail && (
        <>
          <button className="scrim" type="button" tabIndex={-1} aria-label={x.closeDetails} onClick={closeSheet} />
          <section className="sheet" role="dialog" aria-modal="true" aria-label={x.itemDetail} tabIndex={-1} ref={sheetRef}>
            <header className="shead">
              <Stamp type={detail.type} big />
              <div className="txt">
                <h2><span>{detail.title}</span>{detail.favorite && <Star />}</h2>
                <p>{typeLabel(dict, detail.type)}{detailUrl ? ` · ${hostOfUrl(detailUrl)}` : ''}</p>
              </div>
              <button className="ib" type="button" aria-label={x.closeDetails} onClick={closeSheet}><Icon name="x" /></button>
            </header>
            <div className="sbody">
              {detailUsername && (
                <div className="drow"><span className="lab">{x.username}</span><span className="val">{detailUsername}</span>
                  <span className="acts"><button className="ib" type="button" aria-label={x.copyUsername} onClick={() => void copy(detailUsername, x.usernameCopied)}><Icon name="copy" /></button></span></div>
              )}
              {detailPassword && (
                <div className="drow"><span className="lab">{x.password}</span>
                  {showPassword
                    ? <span className="val secret"><Colorized text={detailPassword} /></span>
                    : <span className="val secret masked" aria-label={x.passwordHidden}>{'•'.repeat(12)}</span>}
                  <span className="acts">
                    <button className="ib" type="button" aria-pressed={showPassword} aria-label={showPassword ? x.hidePassword : x.showPassword} onClick={() => setShowPassword((v) => !v)}><Icon name={showPassword ? 'eye-off' : 'eye'} /></button>
                    <button className="ib" type="button" aria-label={x.copyPassword} onClick={() => void copy(detailPassword, x.passwordCopied)}><Icon name="copy" /></button>
                  </span></div>
              )}
              {totp && (
                <div className="drow"><span className="lab">{x.oneTimeCode}</span>
                  <span className="val"><span className="code mono" data-testid="detail-totp"><Code code={totp} /></span>
                    <span className="bar"><i style={{ '--p': `${Math.round((totpLeft / 30) * 100)}%` } as CSSProperties} /><span>{format(x.secondsLeft, totpLeft)}</span></span></span>
                  <span className="acts"><button className="ib" type="button" aria-label={x.copyCode} onClick={() => void copy(totp, x.codeCopied)}><Icon name="copy" /></button></span></div>
              )}
              {detailUrl && <div className="drow"><span className="lab">{x.website}</span><span className="val">{hostOfUrl(detailUrl)}</span><span /></div>}
              {detail.tags.length > 0 && <div className="drow"><span className="lab">{x.tags}</span><span className="val">{detail.tags.join(', ')}</span><span /></div>}
              <p className="dmeta">{format(x.updated, formatDate(locale, new Date(detail.updated_at)))}</p>
            </div>
            <footer className="sfoot">
              <button className="ib lgb" type="button" aria-label={x.moveToTrash} onClick={() => void handleTrash(detail.id)}><Icon name="trash2" /></button>
              <button className="btn btn-primary" type="button" disabled={!detailPassword && !detailUsername} onClick={() => void handleFill(detail.id)}>{x.fillOnPage}</button>
            </footer>
          </section>
        </>
      )}

      {addOpen && (
        <>
          <button className="scrim" type="button" tabIndex={-1} aria-label={x.close} onClick={closeSheet} />
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="add-h" tabIndex={-1} ref={sheetRef}>
            <header className="shead">
              <Stamp type="login" big />
              <div className="txt"><h2 id="add-h"><span>{x.addLoginTitle}</span></h2><p>{x.encryptedHereShort}</p></div>
              <button className="ib" type="button" aria-label={x.close} onClick={closeSheet}><Icon name="x" /></button>
            </header>
            <form className="sbody" id="add-form" onSubmit={(e) => { e.preventDefault(); void handleSaveLogin(); }} noValidate>
              <div className="sform stack">
                <div><label className="label" htmlFor="add-title">{x.title}</label><input id="add-title" name="add-title" type="text" className="input" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder={x.titlePlaceholder} /></div>
                <div><label className="label" htmlFor="add-username">{x.username}</label><input id="add-username" name="add-username" type="text" className="input" value={addUsername} onChange={(e) => setAddUsername(e.target.value)} placeholder={x.usernamePlaceholder} autoComplete="username" /></div>
                <div><label className="label" htmlFor="add-password">{x.password}</label><input id="add-password" name="add-password" type="password" className="input mono" value={addPassword} onChange={(e) => setAddPassword(e.target.value)} placeholder={x.password} autoComplete="new-password" /></div>
                <div><label className="label" htmlFor="add-url">{x.website}</label><input id="add-url" name="add-url" type="url" className="input" value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="https://example.com" /></div>
              </div>
            </form>
            <footer className="sfoot">
              <button className="btn btn-quiet" type="button" onClick={closeSheet}>{x.cancel}</button>
              <button className="btn btn-primary" type="submit" form="add-form">{x.saveLogin}</button>
            </footer>
          </section>
        </>
      )}

      {fillConfirm && (
        <div className={`alertbar${nodock ? ' nodock' : ''}`} role="alert">
          <Msg icon="triangle-alert">{fillConfirm.reason}</Msg>
          <div className="row">
            <button className="btn sm btn-quiet" type="button" onClick={() => setFillConfirm(null)}>{x.cancel}</button>
            <button className="btn sm btn-primary" type="button" onClick={() => void handleFill(fillConfirm.id, true)}>{x.fillAnyway}</button>
          </div>
        </div>
      )}
      {error && !fillConfirm && (
        <div className={`alertbar err${nodock ? ' nodock' : ''}`} role="alert">
          <Msg icon="circle-alert">{error}</Msg>
          <div className="row"><button className="btn sm btn-quiet" type="button" onClick={() => setError('')}>{x.dismiss}</button></div>
        </div>
      )}
      {toastEl(nodock)}
    </div>
  );
}
