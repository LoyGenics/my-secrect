import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VaultItem } from '../../../packages/core/src/types';
import {
  hasVault,
  createVault,
  unlockVault,
  unlockWithRecoveryKey,
  lockVault,
  isUnlocked,
  listItems,
  listTrash,
  upsertItem,
  deleteItem,
  restoreItem,
  permanentlyDeleteItem,
  toggleFavorite,
  searchLocal,
  exportEncrypted,
  exportPlaintext,
  importEncrypted,
  changePassphrase,
  wipeVault,
  getVaultStats,
} from './vault';
import { computeHealth } from './utils/health';
import { buildExampleItems, isExampleItem } from './utils/exampleData';
import SettingsView, { downloadText, type AutoLockMinutes } from './components/SettingsView';
import Sidebar, {
  CATEGORIES,
  categoryForType,
  emptyCounts,
  type SidebarCounts,
  type SidebarView,
} from './components/Sidebar';
import SearchPalette from './components/SearchPalette';
import HealthView from './components/HealthView';
import ItemList from './components/ItemList';
import ItemDetail from './components/ItemDetail';
import ItemForm from './components/ItemForm';
import PasswordGenerator from './components/PasswordGenerator';

/**
 * Desktop shell (Phase 1 prototype) — local-only vault, no server/sync.
 * Uses the real vault.ts API: createVault returns a one-time recovery
 * key, deleteItem soft-deletes to trash, restoreItem /
 * permanentlyDeleteItem manage it, toggleFavorite flips the flag, and
 * exportEncrypted / importEncrypted move the encrypted store.
 * No autofill, no browser-extension UI.
 */

const LS_AUTOLOCK = 'my-secrect.local-vault.autolock-minutes.v1';

// AutoLockMinutes (1 | 5 | 15 | 0 = never) is imported from SettingsView.

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
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
  const label =
    score <= 2 ? 'Weak' : score <= 4 ? 'Fair' : score === 5 ? 'Strong' : 'Very strong';
  return { score, label };
}

export default function App() {
  const [vaultExists, setVaultExists] = useState<boolean>(() => hasVault());
  const [unlocked, setUnlocked] = useState<boolean>(() => isUnlocked());
  const [items, setItems] = useState<VaultItem[]>(() => (isUnlocked() ? listItems() : []));
  const [trash, setTrash] = useState<VaultItem[]>(() => (isUnlocked() ? listTrash() : []));
  const [view, setView] = useState<SidebarView>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPalette, setShowPalette] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [autoLockMinutes, setAutoLockMinutes] = useState<AutoLockMinutes>(() => {
    const saved = readJson<number>(LS_AUTOLOCK, 5);
    return saved === 1 || saved === 5 || saved === 15 || saved === 0 ? saved : 5;
  });
  const [passphrase, setPassphrase] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [lockError, setLockError] = useState('');
  const [notice, setNotice] = useState('');
  // Onboarding (only when no vault exists yet):
  // 0 create passphrase, 1 show recovery key once, 2 done.
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [onboardingError, setOnboardingError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lockTimerRef = useRef<number | null>(null);

  const refresh = useCallback(() => {
    if (isUnlocked()) {
      setItems(listItems());
      setTrash(listTrash());
    }
  }, []);

  const doLock = useCallback(() => {
    lockVault();
    setUnlocked(false);
    setItems([]);
    setTrash([]);
    setSelectedId(null);
    setShowForm(false);
    setEditingItem(null);
    setShowPalette(false);
    setPassphrase('');
    setRecoveryInput('');
    setUseRecovery(false);
    if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current);
  }, []);

  // Auto-lock: reset the timer on pointer / key activity while unlocked.
  useEffect(() => {
    if (!unlocked || autoLockMinutes === 0) return;
    const reset = () => {
      if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current);
      lockTimerRef.current = window.setTimeout(doLock, autoLockMinutes * 60_000);
    };
    reset();
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [unlocked, autoLockMinutes, doLock]);

  useEffect(() => {
    localStorage.setItem(LS_AUTOLOCK, JSON.stringify(autoLockMinutes));
  }, [autoLockMinutes]);

  // Keyboard shortcuts: Cmd/Ctrl+K search palette, Cmd/Ctrl+N new item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (unlocked) setShowPalette((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (unlocked) {
          setEditingItem(null);
          setShowForm(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [unlocked]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => (i.tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [items]);

  const health = useMemo(() => computeHealth(items), [items]);

  const counts = useMemo<SidebarCounts>(() => {
    const c = emptyCounts();
    const stats = getVaultStats();
    c.all = stats.total;
    c.favorites = stats.favorites;
    c.trash = stats.trash;
    c.health = health.weakCount + health.reusedCount;
    for (const item of items) {
      c.categories[categoryForType(item.type)] += 1;
      (item.tags ?? []).forEach((t) => {
        c.tags[t] = (c.tags[t] ?? 0) + 1;
      });
    }
    return c;
  }, [items, health]);

  const visibleItems = useMemo(() => {
    let base: VaultItem[];
    if (view === 'trash') base = trash;
    else if (view === 'favorites') base = items.filter((i) => i.favorite);
    else if (view === 'health') base = items;
    else if (view.startsWith('tag:')) {
      const tag = view.slice(4);
      base = items.filter((i) => (i.tags ?? []).includes(tag));
    } else if (view !== 'all') {
      const cat = CATEGORIES.find((c) => c.key === view);
      base = cat ? items.filter((i) => cat.types.includes(i.type)) : items;
    } else {
      base = items;
    }
    const q = searchQuery.trim();
    if (!q) return base;
    // searchLocal() searches live items only; intersect with the current view.
    const matched = new Set(searchLocal(q).map((i) => i.id));
    return base.filter((i) => matched.has(i.id));
  }, [view, items, trash, searchQuery]);

  const selectedItem = useMemo(
    () =>
      (view === 'trash' ? trash : items).find((i) => i.id === selectedId) ?? null,
    [view, trash, items, selectedId],
  );

  const handleUnlock = async () => {
    setLockError('');
    const ok = useRecovery
      ? recoveryInput.trim()
        ? await unlockWithRecoveryKey(recoveryInput.trim())
        : false
      : passphrase
        ? await unlockVault(passphrase)
        : false;
    if (ok) {
      setUnlocked(true);
      setPassphrase('');
      setRecoveryInput('');
      setUseRecovery(false);
      refresh();
    } else {
      setLockError(
        useRecovery
          ? 'That recovery key did not unlock the vault. Check it and try again.'
          : 'Wrong passphrase, or no vault exists yet.',
      );
    }
  };

  const handleCreateVault = async () => {
    setOnboardingError('');
    if (newPass.length < 8) {
      setOnboardingError('Passphrase must be at least 8 characters.');
      return;
    }
    if (newPass !== newPassConfirm) {
      setOnboardingError('Passphrases do not match.');
      return;
    }
    try {
      const { recoveryKey: key } = await createVault(newPass);
      setRecoveryKey(key);
      setVaultExists(true);
      setUnlocked(true);
      setNewPass('');
      setNewPassConfirm('');
      setOnboardingStep(1);
      refresh();
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : 'Could not create the vault.');
    }
  };

  const handleToggleFavorite = (id: string) => {
    toggleFavorite(id); // flips in memory immediately, re-encrypts async
    refresh();
  };

  const handleDelete = (id: string) => {
    if (view === 'trash') permanentlyDeleteItem(id);
    else deleteItem(id); // soft delete -> trash, restorable
    if (selectedId === id) setSelectedId(null);
    refresh();
  };

  const handleRestore = (id: string) => {
    restoreItem(id);
    refresh();
    setView('all');
    setSelectedId(id);
  };

  const handleSaveItem = async (item: VaultItem) => {
    await upsertItem(item);
    refresh();
    setShowForm(false);
    setEditingItem(null);
    setSelectedId(item.id);
  };

  const handleExport = () => {
    try {
      const blob = new Blob([exportEncrypted()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-secrect-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice('Encrypted backup downloaded. It stays encrypted — keep it safe.');
    } catch {
      setNotice('Export failed.');
    }
  };

  const handleExportPlaintext = () => {
    try {
      // SettingsView already required the explicit acknowledgement checkbox.
      downloadText(`my-secrect-plaintext-export-${new Date().toISOString().slice(0, 10)}.json`, exportPlaintext(), 'application/json');
      setNotice('Plaintext export downloaded. Delete it as soon as you are done — it contains all your secrets in readable form.');
    } catch {
      setNotice('Plaintext export failed.');
    }
  };

  const handleLoadExampleData = async () => {
    try {
      const existing = new Set([...listItems(true)].map((i) => i.id));
      for (const item of buildExampleItems()) {
        if (!existing.has(item.id)) await upsertItem(item);
      }
      refresh();
      setView('all');
      setNotice('Example data loaded — 12 fake items, one per type. All values are fake; delete them with “Clear example data”.');
    } catch {
      setNotice('Could not load example data.');
    }
  };

  const handleClearExampleData = () => {
    const selected = selectedId ? [...items, ...trash].find((i) => i.id === selectedId) : undefined;
    for (const item of [...listItems(true)]) {
      if (isExampleItem(item)) permanentlyDeleteItem(item.id);
    }
    if (selected && isExampleItem(selected)) setSelectedId(null);
    refresh();
    setNotice('Example data cleared.');
  };

  const handleWipeVault = () => {
    wipeVault();
    setVaultExists(false);
    setUnlocked(false);
    setItems([]);
    setTrash([]);
    setSelectedId(null);
    setShowForm(false);
    setEditingItem(null);
    setShowPalette(false);
    setShowRecovery(false);
    setPassphrase('');
    setRecoveryInput('');
    setUseRecovery(false);
    setOnboardingStep(0);
    setView('all');
    setNotice('');
  };

  const handleImportFile = async (file: File) => {
    try {
      // importEncrypted requires an unlocked vault and merges rows by id,
      // keeping the higher revision; rows this vault cannot decrypt are skipped.
      await importEncrypted(await file.text());
      refresh();
      setNotice('Backup imported.');
    } catch (err) {
      setNotice(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed.');
    }
  };

  const viewTitle =
    view === 'all'
      ? 'All Items'
      : view === 'favorites'
        ? 'Favorites'
        : view === 'trash'
          ? 'Trash'
          : view === 'health'
            ? 'Security Health'
            : view === 'settings'
              ? 'Settings'
              : view.startsWith('tag:')
              ? `#${view.slice(4)}`
              : (CATEGORIES.find((c) => c.key === view)?.label ?? 'Vault');

  const emptyMessage =
    view === 'trash'
      ? 'Trash is empty. Deleted items are kept here until you permanently delete them.'
      : view === 'favorites'
        ? 'No favorites yet. Star an item to pin it here.'
        : view === 'health'
          ? 'No items to check yet.'
          : view.startsWith('tag:')
            ? `No items tagged “${view.slice(4)}”.`
            : 'No items in this view yet. Press Cmd/Ctrl+N to add one.';

  // ---------- Onboarding (no vault yet) ----------
  if (!vaultExists) {
    const strength = passphraseScore(newPass);
    return (
      <div className="flex min-h-full items-center justify-center bg-[#0B0F14] p-6">
        <div className="card gradient-subtle w-full max-w-md p-6">
          <h1 className="text-xl font-semibold">my-secrect</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Create your local vault. Everything is encrypted on this device.
          </p>
          <div className="mt-4 flex gap-2 text-xs">
            {['Create passphrase', 'Save recovery key', 'Done'].map((label, i) => (
              <span
                key={label}
                className={`flex-1 rounded-md px-2 py-1.5 text-center ${i === onboardingStep ? 'bg-indigo-600/25 text-indigo-200' : i < onboardingStep ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-900 text-zinc-500'}`}
              >
                {i + 1}. {label}
              </span>
            ))}
          </div>

          {onboardingStep === 0 && (
            <div className="mt-5 space-y-3">
              <div>
                <label className="label" htmlFor="new-pass">Master passphrase</label>
                <input id="new-pass" name="master-passphrase" type="password" className="input" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" aria-label="Master passphrase" />
              </div>
              <div>
                <label className="label" htmlFor="new-pass-confirm">Confirm passphrase</label>
                <input id="new-pass-confirm" name="confirm-passphrase" type="password" className="input" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder="Repeat your passphrase" autoComplete="new-password" aria-label="Confirm passphrase" />
              </div>
              <div>
                <div className="flex justify-between text-xs"><span className="text-zinc-400">Strength</span><span className="text-zinc-200">{newPass ? strength.label : '—'}</span></div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div className={`h-full rounded-full ${strength.score <= 2 ? 'bg-red-500' : strength.score <= 4 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${(strength.score / 6) * 100}%` }} />
                </div>
              </div>
              {onboardingError && <p className="text-sm text-red-400">{onboardingError}</p>}
              <button className="btn-primary w-full" onClick={() => void handleCreateVault()}>Create vault</button>
            </div>
          )}

          {onboardingStep === 1 && (
            <div className="mt-5 space-y-3">
              <p className="text-sm text-zinc-300">
                <strong>Save this recovery key — it is shown only once.</strong> It is the
                only way back in if you forget your passphrase. It is never stored
                on this device in readable form.
              </p>
              <div className="break-all rounded-lg border border-zinc-700 bg-zinc-900 p-3 font-mono text-sm text-zinc-100">
                {recoveryKey}
              </div>
              <button
                className="btn-ghost w-full"
                onClick={() => {
                  void navigator.clipboard?.writeText(recoveryKey).catch(() => undefined);
                  setRecoveryCopied(true);
                }}
              >
                {recoveryCopied ? 'Copied to clipboard' : 'Copy recovery key'}
              </button>
              <label className="flex items-start gap-2 text-sm text-zinc-200">
                <input type="checkbox" checked={recoveryAck} onChange={(e) => setRecoveryAck(e.target.checked)} className="mt-1 accent-indigo-600" />
                I have saved my recovery key somewhere safe.
              </label>
              <button className="btn-primary w-full" disabled={!recoveryAck} onClick={() => setOnboardingStep(2)}>
                Done
              </button>
            </div>
          )}

          {onboardingStep === 2 && (
            <div className="mt-5 space-y-3 text-center">
              <p className="text-2xl">✓</p>
              <p className="text-sm text-zinc-300">Your vault is created and unlocked. Add your first item to get started.</p>
              <button className="btn-primary w-full" onClick={() => { setOnboardingStep(0); setView('all'); }}>
                Open vault
              </button>
            </div>
          )}
          <p className="mt-4 text-xs text-zinc-500">
            Prototype: Argon2id + XChaCha20-Poly1305 via libsodium. Not audited — do not treat as production-ready.
          </p>
        </div>
      </div>
    );
  }

  // ---------- Lock screen ----------
  if (!unlocked) {
    return (
      <div className="flex min-h-full items-center justify-center bg-[#0B0F14] p-6">
        <div className="card gradient-subtle w-full max-w-sm p-6">
          <h1 className="text-xl font-semibold">my-secrect</h1>
          <p className="mt-1 text-sm text-zinc-400">Your vault is locked. Enter your passphrase to unlock.</p>
          <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); void handleUnlock(); }}>
            {useRecovery ? (
              <div>
                <label className="label" htmlFor="lock-recovery-key">Recovery key</label>
                <input id="lock-recovery-key" name="recovery-key" type="text" className="input font-mono" value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} placeholder="Paste your recovery key" autoComplete="off" aria-label="Recovery key" autoFocus />
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="lock-passphrase">Master passphrase</label>
                <input id="lock-passphrase" name="master-passphrase" type="password" className="input" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Master passphrase" autoComplete="current-password" aria-label="Master passphrase" autoFocus />
              </div>
            )}
            {lockError && <p className="text-sm text-red-400">{lockError}</p>}
            <button type="submit" className="btn-primary w-full">
              {useRecovery ? 'Unlock with recovery key' : 'Unlock'}
            </button>
          </form>
          <button
            className="mt-3 w-full text-center text-sm text-indigo-300 hover:text-indigo-200"
            onClick={() => { setUseRecovery((v) => !v); setLockError(''); }}
          >
            {useRecovery ? 'Use passphrase instead…' : 'Unlock with a recovery key…'}
          </button>
        </div>
      </div>
    );
  }

  // ---------- Unlocked shell ----------
  return (
    <div className="flex h-full bg-[#0B0F14] text-zinc-100">
      <Sidebar
        view={view}
        setView={(v) => { setView(v); setSelectedId(null); setShowForm(false); setEditingItem(null); }}
        counts={counts}
        tags={tags}
        onLock={doLock}
        onExport={handleExport}
        onImport={() => fileInputRef.current?.click()}
        onShowRecovery={() => setShowRecovery((v) => !v)}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleImportFile(f);
          e.target.value = '';
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <h1 className="text-base font-semibold">{viewTitle}</h1>
          <div className="relative max-w-md flex-1">
            <input
              id="search-items"
              name="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search… (Cmd+K)"
              className="input !py-1.5"
              aria-label="Search items"
              autoComplete="off"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400" htmlFor="header-auto-lock">
              Auto-lock
              <select id="header-auto-lock" name="auto-lock" aria-label="Auto-lock after" value={autoLockMinutes} onChange={(e) => setAutoLockMinutes(Number(e.target.value) as AutoLockMinutes)} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                <option value={1}>1 min</option>
                <option value={5}>5 min</option>
                <option value={15}>15 min</option>
                <option value={0}>Never</option>
              </select>
            </label>
            <button className="btn-ghost !py-1.5" onClick={() => setShowGenerator((v) => !v)}>Generate password</button>
            <button className="btn-primary !py-1.5" onClick={() => { setEditingItem(null); setShowForm(true); }}>+ New item</button>
          </div>
        </header>

        {notice && (
          <div className="mx-5 mt-3 flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
            <span>{notice}</span>
            <button className="text-zinc-400 hover:text-zinc-100" onClick={() => setNotice('')}>✕</button>
          </div>
        )}

        {showRecovery && (
          <div className="mx-5 mt-3 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
            Your recovery key was shown only once, when this vault was created, and
            cannot be displayed again. If you still have it, use it on the lock
            screen (lock the vault, then “Unlock with a recovery key…”).
            <button className="ml-3 underline" onClick={() => setShowRecovery(false)}>Close</button>
          </div>
        )}

        {showGenerator && (
          <div className="mx-5 mt-3 card p-4">
            <PasswordGenerator onUse={(pw: string) => { setGeneratedPassword(pw); void navigator.clipboard?.writeText(pw).catch(() => undefined); }} />
            {generatedPassword && <p className="mt-2 break-all font-mono text-sm text-zinc-200">{generatedPassword} <span className="text-xs text-zinc-500">(copied to clipboard)</span></p>}
          </div>
        )}

        {view === 'settings' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SettingsView
              autoLockMinutes={autoLockMinutes}
              onAutoLockChange={setAutoLockMinutes}
              itemCount={items.length}
              onExportEncrypted={handleExport}
              onExportPlaintext={handleExportPlaintext}
              onImport={() => fileInputRef.current?.click()}
              onChangePassphrase={async (oldP, newP) => { await changePassphrase(oldP, newP); setNotice('Passphrase changed.'); }}
              onWipeVault={handleWipeVault}
            />
          </div>
        ) : view === 'health' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <HealthView items={items} onFix={(item) => { setView('all'); setSelectedId(item.id); setEditingItem(item); setShowForm(true); }} />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1">
          <section className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800 p-3">
            {visibleItems.length === 0 ? (
              <div className="px-2 py-8 text-center">
                <p className="text-sm text-zinc-500">{emptyMessage}</p>
                {items.length === 0 && view !== 'trash' && view !== 'health' && (
                  <button type="button" className="btn-ghost mt-4" onClick={() => void handleLoadExampleData()}>
                    Load example data
                  </button>
                )}
                {items.some(isExampleItem) && (
                  <button type="button" className="btn-ghost mt-4 ml-2" onClick={handleClearExampleData}>
                    Clear example data
                  </button>
                )}
                {items.length === 0 && view !== 'trash' && view !== 'health' && (
                  <p className="mt-3 text-xs text-zinc-600">Example data is clearly labelled EXAMPLE DATA — every value is fake.</p>
                )}
              </div>
            ) : (
              <ItemList
                items={visibleItems}
                selectedId={selectedId}
                onSelect={(id: string) => { setSelectedId(id); setShowForm(false); setEditingItem(null); }}
                onToggleFavorite={handleToggleFavorite}
                onDelete={handleDelete}
              />
            )}
          </section>

          <section className="min-w-0 flex-1 overflow-y-auto p-5">
            {showForm ? (
              <ItemForm
                initial={editingItem ?? undefined}
                allItems={items}
                onSave={(item: VaultItem) => void handleSaveItem(item)}
                onCancel={() => { setShowForm(false); setEditingItem(null); }}
              />
            ) : selectedItem ? (
              <ItemDetail
                item={selectedItem}
                allItems={items}
                onEdit={(item: VaultItem) => { setEditingItem(item); setShowForm(true); }}
                onDelete={() => handleDelete(selectedItem.id)}
                onRestore={() => handleRestore(selectedItem.id)}
                onToggleFavorite={() => handleToggleFavorite(selectedItem.id)}
                onClose={() => setSelectedId(null)}
                onSelectRelated={(id) => { setSelectedId(id); setShowForm(false); setEditingItem(null); }}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <p className="text-zinc-400">Select an item to view it, or create a new one.</p>
                <p className="mt-1 text-xs text-zinc-500">Cmd/Ctrl+K to search · Cmd/Ctrl+N for a new item</p>
                {items.length === 0 && (
                  <div className="mt-4">
                    <button type="button" className="btn-ghost" onClick={() => void handleLoadExampleData()}>
                      Load example data
                    </button>
                    <p className="mt-2 text-xs text-zinc-600">Loads 12 fake items, one per type — clearly labelled EXAMPLE DATA.</p>
                  </div>
                )}
                {items.some(isExampleItem) && (
                  <button type="button" className="btn-ghost mt-4" onClick={handleClearExampleData}>
                    Clear example data
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
        )}
      </main>

      <SearchPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        items={items}
        onSelect={(item) => {
          setSelectedId(item.id);
          setView('all');
          setShowForm(false);
          setEditingItem(null);
        }}
      />
    </div>
  );
}
