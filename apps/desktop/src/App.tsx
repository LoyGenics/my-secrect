import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  upsertItems,
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
  verifyPassphrase,
  encryptWithVaultKey,
  decryptWithVaultKey,
} from './vault';
import { computeHealth } from './utils/health';
import { buildExampleItems, isExampleItem } from './utils/exampleData';
import { isArchived, getNoteRevisions, appendNoteRevision } from './utils/itemMeta';
import { parseEncryptedExportText, type ItemListCheck } from '../../../packages/import-export/src/index';
import SettingsView, { downloadText, type AutoLockMinutes } from './components/SettingsView';
import Sidebar, {
  CATEGORIES,
  categoryForType,
  emptyCounts,
  SETTINGS_VIEWS,
  type SidebarCounts,
  type SidebarView,
} from './components/Sidebar';
import SearchPalette from './components/SearchPalette';
import HealthView from './components/HealthView';
import ItemList, { itemDisplayTitle } from './components/ItemList';
import FilterPopover from './components/FilterPopover';
import ItemDetail from './components/ItemDetail';
import ItemForm from './components/ItemForm';
import PasswordGenerator from './components/PasswordGenerator';
import MediaView from './components/MediaView';
import SharesView from './components/SharesView';
import SecurityCenter from './components/SecurityCenter';
import StepUpDialog from './components/StepUpDialog';
import { useSync } from './sync/useSync';
import SyncBar from './sync/SyncBar';
import SignInScreen from './components/SignInScreen';
import ConnectServerScreen from './components/ConnectServerScreen';
import {
  SecurityApiClient,
  isStepUpFresh,
  LS_ACCOUNT_EMAIL,
  clearSessionToken,
  getValidToken,
  getValidTokenSync,
  webTokenStore,
} from '../../../packages/sdk/src/security';
import { VaultApiClient } from '../../../packages/sdk/src/index';
import { RestoreBackup, RestoreSuccess } from './components/RestoreBackup';
import { authGateStep, resolveApiBaseUrl } from './authGate';
import { I18nProvider } from '../../../packages/i18n/src/react';
import { detectLocale, format, getDictionary, plural, storeLocale, type Locale, type PluralForms } from '../../../packages/i18n/src/index';
import {
  Alert,
  Art,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  DropdownMenu,
  Kbd,
  Progress,
  SecureField,
  Sheet,
  brandMark,
  copyWithClear,
  illustrations,
  initTheme,
  useClipboardStatus,
  type IconName,
  type MenuItemDef,
  type ArtSource,
} from './theme';

/**
 * Desktop shell (Phase 1 prototype) — local-only vault, no server/sync.
 * Uses the real vault.ts API: createVault returns a one-time recovery
 * key, deleteItem soft-deletes to trash, restoreItem /
 * permanentlyDeleteItem manage it, toggleFavorite flips the flag, and
 * exportEncrypted / importEncrypted move the encrypted store.
 * No autofill, no browser-extension UI.
 *
 * The web client renders this same App (apps/web/src/App.tsx). It MUST
 * pass allowPlaintextExport={false}: plaintext export is desktop-only,
 * and the web banner promises encrypted-only export. Passing nothing
 * keeps the desktop default (plaintext allowed behind the Settings
 * warning + acknowledgement checkbox).
 */

const LS_AUTOLOCK = 'my-secrect.local-vault.autolock-minutes.v1';
/** API base URL for the account server, saved on this device. Empty =
 *  use the build default; with neither, the app asks for one before
 *  anything else (authGate.ts). The server never sees vault content. */
const LS_API_BASE_URL = 'my-secrect:api-base-url';

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

export type ItemSort = 'updated' | 'title' | 'created';

export default function App({
  allowPlaintextExport = true,
  defaultApiBaseUrl = '',
}: { allowPlaintextExport?: boolean; defaultApiBaseUrl?: string } = {}) {
  const [vaultExists, setVaultExists] = useState<boolean>(() => hasVault());
  const [unlocked, setUnlocked] = useState<boolean>(() => isUnlocked());
  const [items, setItems] = useState<VaultItem[]>(() => (isUnlocked() ? listItems() : []));
  const [trash, setTrash] = useState<VaultItem[]>(() => (isUnlocked() ? listTrash() : []));
  const [view, setView] = useState<SidebarView>(() => new URLSearchParams(window.location.search).has('billing') ? 'settings' : 'all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPalette, setShowPalette] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState('');
  const { copiedKey, secondsLeft } = useClipboardStatus();
  // Phone navigation drawer, unlock "key turn" overlay, KDF busy flags.
  const [navOpen, setNavOpen] = useState(false);
  const [keyTurn, setKeyTurn] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [creating, setCreating] = useState(false);
  // One I18nProvider wraps every screen (same tree position, so its state
  // survives lock/unlock); App mirrors the locale to read strings itself.
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const dict = useMemo(() => getDictionary(locale), [locale]);
  const tp = (forms: PluralForms, count: number, ...args: Array<string | number>) => plural(locale, forms, count, ...args);
  const handleLocaleChange = useCallback((next: Locale) => {
    storeLocale(next);
    setLocale(next);
  }, []);
  const frame = (node: ReactNode) => (
    <I18nProvider initialLocale={locale} onLocaleChange={handleLocaleChange}>
      {node}
    </I18nProvider>
  );
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
  const [restoreUi, setRestoreUi] = useState<null | { count: null } | { count: number; itemList: ItemListCheck }>(null);
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [onboardingError, setOnboardingError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lockTimerRef = useRef<number | null>(null);
  // List sorting + bulk selection.
  const [sort, setSort] = useState<ItemSort>('title');
  const [selectionMode, setSelectionMode] = useState(false);
  const [filterCats, setFilterCats] = useState<ReadonlySet<string>>(new Set());
  const [filterTags, setFilterTags] = useState<ReadonlySet<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [bulkIds, setBulkIds] = useState<Set<string>>(new Set());
  // Account server: the saved URL, else the build default. Without either
  // the gate asks for one (ConnectServerScreen). The token getter reads the
  // stored account session token, if a sign-in flow has stored one;
  // otherwise calls go out without Authorization and the server answers 401.
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => {
    try {
      return resolveApiBaseUrl(localStorage.getItem(LS_API_BASE_URL), defaultApiBaseUrl);
    } catch {
      return resolveApiBaseUrl(null, defaultApiBaseUrl);
    }
  });
  // "Use a different server" from the sign-in screen: show the URL step again.
  const [changingServer, setChangingServer] = useState(false);
  const securityClient = useMemo<SecurityApiClient | null>(() => {
    const base = apiBaseUrl.trim();
    if (!base) return null;
    // The token getter is expiry-aware (getValidToken): an expired
    // token reads as null, so calls never go out with a stale token
    // and the server never has to 401 them. tokenStore lets the
    // client adopt `rotated_token` responses automatically.
    const store = webTokenStore();
    return new SecurityApiClient({
      baseUrl: base,
      getToken: () => getValidToken(store),
      tokenStore: store,
    });
  }, [apiBaseUrl]);
  // Encrypted media upload/download client (same base URL + expiry-aware token as above).
  const mediaApi = useMemo(() => {
    const base = apiBaseUrl.trim().replace(/\/+$/, '');
    if (!base) return null;
    const store = webTokenStore();
    return new VaultApiClient({ baseUrl: base, getToken: () => getValidToken(store) });
  }, [apiBaseUrl]);
  // --- Account sign-in state (WorkOS scope) --------------------------
  // Signed-in = a valid (unexpired) session token is stored. The
  // gate below shows SignInScreen before the vault whenever there is
  // no valid session. Vault unlock
  // (master passphrase) stays a SEPARATE step after sign-in.
  const [signedIn, setSignedIn] = useState<boolean>(() => {
    try {
      return getValidTokenSync(webTokenStore()) !== null;
    } catch {
      return false;
    }
  });
  const [accountEmail, setAccountEmail] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_ACCOUNT_EMAIL) ?? '';
    } catch {
      return '';
    }
  });
  // Set when a server call answers 401: the gate reappears with a
  // 'session expired' note instead of silently retrying.
  const [sessionExpired, setSessionExpired] = useState(false);

  const handleSignedIn = useCallback((email: string) => {
    setAccountEmail(email);
    setSignedIn(true);
    setSessionExpired(false);
  }, []);

  // The server confirmed account deletion: drop the (now dead) session and
  // email and return to the sign-in gate. The local vault is NOT erased.
  const handleAccountDeleted = useCallback(() => {
    void clearSessionToken(webTokenStore());
    try { localStorage.removeItem(LS_ACCOUNT_EMAIL); } catch { /* non-critical */ }
    setAccountEmail('');
    setSignedIn(false);
    setSessionExpired(false);
  }, []);

  const handleUnauthorized = useCallback(() => {
    // A 401 means the stored session is gone server-side (revoked
    // or expired). Clear it locally and send the user back to
    // SignIn with a "session expired" note; never retry with the
    // same stale token.
    void clearSessionToken(webTokenStore());
    setSignedIn(false);
    setSessionExpired(true);
  }, []);
  // Step-up (10-minute window, STEP_UP_WINDOW_MS in the SDK): a pending
  // action runs only after a fresh verification. requestStepUp runs the
  // action at once when the window is still fresh, otherwise it opens
  // the dialog and runs it on success. Cancelling never runs it.
  const [stepUpVerifiedAt, setStepUpVerifiedAt] = useState<number | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpReason, setStepUpReason] = useState<'export' | undefined>(undefined);
  const stepUpPendingRef = useRef<{ run: () => void; onCancel?: () => void } | null>(null);
  const requestStepUp = useCallback(
    (run: () => void, opts?: { reason?: 'export'; onCancel?: () => void }) => {
      if (isStepUpFresh(stepUpVerifiedAt)) {
        run();
        return;
      }
      stepUpPendingRef.current = { run, onCancel: opts?.onCancel };
      setStepUpReason(opts?.reason);
      setStepUpOpen(true);
    },
    [stepUpVerifiedAt],
  );
  const handleStepUpVerified = useCallback(() => {
    setStepUpVerifiedAt(Date.now());
    setStepUpOpen(false);
    setStepUpReason(undefined);
    const pending = stepUpPendingRef.current;
    stepUpPendingRef.current = null;
    pending?.run();
  }, []);
  const handleStepUpCancel = useCallback(() => {
    setStepUpOpen(false);
    setStepUpReason(undefined);
    const pending = stepUpPendingRef.current;
    stepUpPendingRef.current = null;
    pending?.onCancel?.();
  }, []);
  const handleApiBaseUrlChange = useCallback((url: string) => {
    const next = resolveApiBaseUrl(url, defaultApiBaseUrl);
    setChangingServer(false);
    if (next === apiBaseUrl) return;
    setApiBaseUrl(next);
    // A stored token belongs to the previous server: a changed URL
    // always requires signing in again. Clearing the URL falls back to
    // the build default, or to the "connect to your server" step.
    void clearSessionToken(webTokenStore());
    setAccountEmail('');
    setSignedIn(false);
    setSessionExpired(false);
    doLock();
    try {
      const trimmed = url.trim();
      if (trimmed) localStorage.setItem(LS_API_BASE_URL, trimmed);
      else localStorage.removeItem(LS_API_BASE_URL);
    } catch {
      // API URL persistence is non-critical; a full localStorage must not break the vault.
    }
    // doLock is declared below; it is only called, never read, during render.
  }, [defaultApiBaseUrl, apiBaseUrl]);

  useEffect(() => initTheme().dispose, []);

  // Key turn: after a successful unlock the device face plays the LED sweep
  // and slides away over the instrument panel (CSS; crossfade under reduced motion).
  useEffect(() => {
    if (!keyTurn) return;
    const id = window.setTimeout(() => setKeyTurn(false), 520);
    return () => window.clearTimeout(id);
  }, [keyTurn]);

  const refresh = useCallback(() => {
    if (isUnlocked()) {
      setItems(listItems());
      setTrash(listTrash());
    }
  }, []);

  // Sync (packages/sync via SDK): runs only while signed in AND unlocked.
  const sync = useSync({
    enabled: signedIn && unlocked,
    apiBaseUrl,
    accountEmail,
    onItemsChanged: refresh,
    onUnauthorized: handleUnauthorized,
  });

  const doLock = useCallback(() => {
    lockVault();
    setUnlocked(false);
    setItems([]);
    setTrash([]);
    setSelectedId(null);
    setShowForm(false);
    setEditingItem(null);
    setShowPalette(false);
    setNavOpen(false);
    setPassphrase('');
    setRecoveryInput('');
    setUseRecovery(false);
    if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current);
  }, []);

  /** Sign out of the account AND lock the vault. The server session
   *  is revoked first (revokeCurrentSession finds the `current`
   *  session and DELETEs it); when the server cannot confirm —
   *  offline, or the session already expired — local sign-out
   *  still proceeds and the token is cleared regardless, so the
   *  user is never stuck signed in. Revocation invalidates the
   *  server session only; it does NOT erase secrets already
   *  downloaded or cached offline on this device. */
  const handleSignOut = useCallback(async () => {
    if (securityClient) {
      try {
        await securityClient.revokeCurrentSession();
      } catch {
        // Server revocation unconfirmed; local sign-out proceeds.
      }
    }
    await clearSessionToken(webTokenStore());
    setAccountEmail('');
    setSignedIn(false);
    setSessionExpired(false);
    doLock();
  }, [securityClient, doLock]);

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

  // Archived items are hidden from All Items, categories, tags, search
  // and health — they live in the Archived view until unarchived.
  const liveItems = useMemo(() => items.filter((i) => !isArchived(i)), [items]);
  const archivedItems = useMemo(() => items.filter((i) => isArchived(i)), [items]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    liveItems.forEach((i) => (i.tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [liveItems]);

  const health = useMemo(() => computeHealth(liveItems), [liveItems]);

  const counts = useMemo<SidebarCounts>(() => {
    const c = emptyCounts();
    const stats = getVaultStats();
    c.all = liveItems.length;
    c.favorites = liveItems.filter((i) => i.favorite).length;
    c.trash = stats.trash;
    c.archived = archivedItems.length;
    c.health = health.weakCount + health.reusedCount;
    for (const item of liveItems) {
      c.categories[categoryForType(item.type)] += 1;
      (item.tags ?? []).forEach((t) => {
        c.tags[t] = (c.tags[t] ?? 0) + 1;
      });
    }
    return c;
  }, [liveItems, archivedItems, health]);

  /** Items of the current view (scope + search), before the filter popover. */
  const scopedItems = useMemo(() => {
    let base: VaultItem[];
    if (view === 'trash') base = trash;
    else if (view === 'archived') base = archivedItems;
    else if (view === 'favorites') base = liveItems.filter((i) => i.favorite);
    else if (view === 'health') base = liveItems;
    else if (view.startsWith('tag:')) {
      const tag = view.slice(4);
      base = liveItems.filter((i) => (i.tags ?? []).includes(tag));
    } else if (view !== 'all') {
      const cat = CATEGORIES.find((c) => c.key === view);
      base = cat ? liveItems.filter((i) => cat.types.includes(i.type)) : liveItems;
    } else {
      base = liveItems;
    }
    const q = searchQuery.trim();
    if (q) {
      // searchLocal() searches live items only; intersect with the current view.
      // Archived items are excluded from search (they are not in liveItems).
      const matched = new Set(searchLocal(q).map((i) => i.id));
      base = base.filter((i) => matched.has(i.id));
    }
    return base;
  }, [view, liveItems, archivedItems, trash, searchQuery]);

  // Filter popover: categories OR'ed, tags OR'ed, the two groups AND'ed.
  const inCategories = (item: VaultItem, cats: ReadonlySet<string>) => cats.size === 0 || cats.has(categoryForType(item.type));
  const inTags = (item: VaultItem, tagSet: ReadonlySet<string>) => tagSet.size === 0 || (item.tags ?? []).some((t) => tagSet.has(t));
  const visibleItems = useMemo(() => {
    const sorted = scopedItems.filter((i) => inCategories(i, filterCats) && inTags(i, filterTags));
    if (sort === 'title') sorted.sort((a, b) => itemDisplayTitle(a).localeCompare(itemDisplayTitle(b)));
    else if (sort === 'created') sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    else sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sorted;
  }, [scopedItems, filterCats, filterTags, sort]);

  const selectedItem = useMemo(
    () =>
      (view === 'trash' ? trash : items).find((i) => i.id === selectedId) ?? null,
    [view, trash, items, selectedId],
  );

  const handleUnlock = async () => {
    setLockError('');
    setUnlocking(true);
    let ok = false;
    try {
      ok = useRecovery
        ? recoveryInput.trim()
          ? await unlockWithRecoveryKey(recoveryInput.trim())
          : false
        : passphrase
          ? await unlockVault(passphrase)
          : false;
    } finally {
      setUnlocking(false);
    }
    if (ok) {
      setKeyTurn(true);
      setUnlocked(true);
      setPassphrase('');
      setRecoveryInput('');
      setUseRecovery(false);
      refresh();
    } else {
      setLockError(useRecovery ? dict.lock.wrongRecovery : dict.lock.wrongPassphrase);
    }
  };

  const handleCreateVault = async () => {
    setOnboardingError('');
    if (newPass.length < 8) {
      setOnboardingError(dict.onboarding.tooShort);
      return;
    }
    if (newPass !== newPassConfirm) {
      setOnboardingError(dict.onboarding.mismatch);
      return;
    }
    setCreating(true);
    try {
      const { recoveryKey: key } = await createVault(newPass);
      setRecoveryKey(key);
      // vaultExists flips only when onboarding finishes ("Open vault"): the
      // onboarding branch below must stay mounted to show the one-time
      // recovery key. Flipping it here unmounted it and the key was never shown.
      setUnlocked(true);
      setNewPass('');
      setNewPassConfirm('');
      setOnboardingStep(1);
      refresh();
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : dict.onboarding.createFailed);
    } finally {
      setCreating(false);
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

  const handleSaveItem = async (item: VaultItem, localCardCode?: string) => {
    await upsertItem(item, localCardCode);
    refresh();
    setShowForm(false);
    setEditingItem(null);
    setSelectedId(item.id);
  };

  // Step-up gate: an export runs ONLY after a fresh verification (the
  // dialog offers the master passphrase, plus TOTP / passkey when a
  // server is configured). This one gate covers every export entry
  // point — the sidebar button and the Settings backup buttons both
  // call handleExport / handleExportPlaintext below.
  const doExportEncrypted = async () => {
    try {
      const blob = new Blob([await exportEncrypted()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-secrect-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(dict.notices.exportDone);
    } catch {
      setNotice(dict.notices.exportFailed);
    }
  };

  const handleExport = () => {
    requestStepUp(() => void doExportEncrypted(), { reason: 'export' });
  };

  const doExportPlaintext = () => {
    // H2 fix: plaintext export is desktop-only. The web client renders
    // this App with allowPlaintextExport={false}; the Settings UI hides
    // the button there, and this guard is the second line of defence so
    // no code path can produce a plaintext file on web.
    if (!allowPlaintextExport) {
      setNotice(dict.notices.plaintextBlocked);
      return;
    }
    try {
      // SettingsView already required the explicit acknowledgement checkbox.
      downloadText(`my-secrect-plaintext-export-${new Date().toISOString().slice(0, 10)}.json`, exportPlaintext(), 'application/json');
      setNotice(dict.notices.plaintextDone);
    } catch {
      setNotice(dict.notices.plaintextFailed);
    }
  };

  const handleExportPlaintext = () => {
    requestStepUp(doExportPlaintext, { reason: 'export' });
  };

  /**
   * Change-passphrase goes through step-up first (the dialog's
   * passphrase check is in addition to the form's own
   * current-passphrase check inside changePassphrase). The returned
   * promise settles only after verification + change, so SettingsView
   * can show its success / error state; cancelling the dialog rejects
   * it and nothing is changed.
   */
  const handleChangePassphraseRequest = (oldP: string, newP: string) =>
    new Promise<void>((resolve, reject) => {
      requestStepUp(
        () => {
          void changePassphrase(oldP, newP)
            .then(() => {
              setNotice(dict.notices.passphraseChanged);
              resolve();
            })
            .catch(reject);
        },
        { onCancel: () => reject(new Error('Step-up cancelled.')) },
      );
    });

  const handleLoadExampleData = async () => {
    try {
      const existing = new Set([...listItems(true)].map((i) => i.id));
      for (const item of buildExampleItems()) {
        if (!existing.has(item.id)) await upsertItem(item);
      }
      refresh();
      setView('all');
      setNotice(dict.notices.exampleLoaded);
    } catch {
      setNotice(dict.notices.exampleFailed);
    }
  };

  const handleClearExampleData = () => {
    const selected = selectedId ? [...items, ...trash].find((i) => i.id === selectedId) : undefined;
    for (const item of [...listItems(true)]) {
      if (isExampleItem(item)) permanentlyDeleteItem(item.id);
    }
    if (selected && isExampleItem(selected)) setSelectedId(null);
    refresh();
    setNotice(dict.notices.exampleCleared);
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
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNotice(dict.notices.importReadFailed);
      return;
    }
    // Validate BEFORE touching the vault: wrong format, newer/older
    // version, malformed rows and plaintext files are all rejected here
    // with a specific message instead of a generic failure.
    const { validation } = parseEncryptedExportText(text);
    if (!validation.ok) {
      setNotice(format(dict.notices.importFailedWith, validation.errors.join(' ')));
      return;
    }
    const beforeIds = new Set(listItems(true).map((i) => i.id));
    try {
      // importEncrypted requires an unlocked vault and merges rows by id,
      // keeping the higher revision. Any decrypt failure or id mismatch
      // rejects the whole file and nothing is written; only rows with an
      // older revision than the stored one are skipped.
      const itemList = await importEncrypted(text);
      refresh();
      const after = listItems(true);
      const newCount = after.filter((i) => !beforeIds.has(i.id)).length;
      setNotice(
        format(dict.notices.backupImported, tp(dict.notices.fileItems, validation.itemCount), tp(dict.notices.newItems, newCount)) +
          (itemList === 'unverifiable-legacy' ? ` ${dict.notices.importItemListUnverified}` : '') +
          (validation.warnings.length > 0 ? ` ${format(dict.notices.importNote, validation.warnings.join(' '))}` : ''),
      );
    } catch (err) {
      setNotice(err instanceof Error ? format(dict.notices.importFailedWith, err.message) : dict.notices.importFailed);
    }
  };

  const handleImportItems = async (imported: VaultItem[]) => {
    await upsertItems(imported);
    refresh();
  };

  /** Autosave for secure notes: upsert without closing the form. */
  const handleAutosaveItem = async (item: VaultItem) => {
    await upsertItem(item);
    refresh();
  };

  const handleArchive = async (id: string) => {
    const item = [...items, ...trash].find((i) => i.id === id);
    if (!item) return;
    const archived = isArchived(item);
    await upsertItem({ ...item, fields: { ...item.fields, archived: !archived } });
    if (!archived && selectedId === id && view !== 'archived') setSelectedId(null);
    refresh();
    setNotice(archived ? dict.notices.unarchived : dict.notices.archived);
  };

  /** Restore a note revision: the current body becomes a revision first. */
  const handleRestoreRevision = async (restored: VaultItem) => {
    const original = items.find((i) => i.id === restored.id);
    const oldBody = typeof original?.fields?.body === 'string' ? (original.fields.body as string) : '';
    const newBody = typeof restored.fields?.body === 'string' ? (restored.fields.body as string) : '';
    const fields = { ...restored.fields };
    if (oldBody && oldBody !== newBody) {
      fields.revisions = appendNoteRevision(getNoteRevisions(original ?? restored), oldBody);
    }
    await upsertItem({ ...restored, fields });
    refresh();
    setSelectedId(restored.id);
    setNotice(dict.notices.revisionRestored);
  };

  /** Sharing: the owner's explicit "Save this version to my vault". */
  const handleSaveSharedItem = async (item: VaultItem) => {
    await upsertItem(item);
    refresh();
  };

  const handleBulkFavorite = async () => {
    const ids = [...bulkIds];
    for (const id of ids) {
      const item = items.find((i) => i.id === id);
      if (item && !item.favorite) await upsertItem({ ...item, favorite: true });
    }
    setBulkIds(new Set());
    setSelectionMode(false);
    refresh();
    setNotice(tp(dict.notices.bulkFavorited, ids.length));
  };

  const handleBulkDelete = async () => {
    const ids = [...bulkIds];
    for (const id of ids) {
      if (view === 'trash') permanentlyDeleteItem(id);
      else deleteItem(id);
    }
    if (selectedId && bulkIds.has(selectedId)) setSelectedId(null);
    setBulkIds(new Set());
    setSelectionMode(false);
    refresh();
    setNotice(tp(view === 'trash' ? dict.notices.bulkDeleted : dict.notices.bulkTrashed, ids.length));
  };

  const handleBulkRestore = async () => {
    const ids = [...bulkIds];
    for (const id of ids) restoreItem(id);
    setBulkIds(new Set());
    setSelectionMode(false);
    refresh();
    setNotice(tp(dict.notices.bulkRestored, ids.length));
  };

  const sh = dict.shell;
  const categoryTitle = (key: string) => (dict.categories as Record<string, string>)[key];
  const viewTitle =
    view === 'all'
      ? sh.allItems
      : view === 'favorites'
        ? sh.favorites
        : view === 'trash'
          ? sh.trash
          : view === 'archived'
            ? sh.archived
            : view === 'media-gallery'
              ? sh.mediaGallery
              : view === 'shares'
                ? sh.sharing
                : view === 'health'
                  ? sh.watchtower
                  : view === 'generator'
                    ? sh.generator
                    : view === 'settings'
                      ? sh.settings
                      : view === 'security'
                        ? sh.securityCenter
                        : view.startsWith('tag:')
                          ? `#${view.slice(4)}`
                          : (categoryTitle(view) ?? sh.allItems);

  const isListView = !['settings', 'security', 'health', 'generator', 'media-gallery', 'shares'].includes(view);

  /** Navigate: every view change also closes the detail/form (phones pop back to the list). */
  const go = (v: SidebarView) => {
    setView(v);
    setFilterCats(new Set());
    setFilterTags(new Set());
    setFilterOpen(false);
    setSelectedId(null);
    setShowForm(false);
    setEditingItem(null);
    setNavOpen(false);
  };

  const emptyListState = () => {
    const q = searchQuery.trim();
    if (q) return { art: illustrations.noResults, title: sh.empty.searchTitle, body: format(sh.empty.searchBody, q) };
    if (view === 'trash') return { art: illustrations.emptyTrash, title: sh.empty.trashTitle, body: sh.empty.trashBody };
    if (view === 'archived') return { art: illustrations.emptyArchive, title: sh.empty.archivedTitle, body: sh.empty.archivedBody };
    if (view === 'favorites') return { art: illustrations.emptyFavorites as ArtSource, title: sh.empty.favoritesTitle, body: sh.empty.favoritesBody };
    if (view.startsWith('tag:')) return { art: illustrations.emptyVault, title: sh.empty.tagTitle, body: format(sh.empty.tagBody, view.slice(4)) };
    return { art: illustrations.emptyVault, title: sh.empty.allTitle, body: sh.empty.allBody };
  };

  // ---------- Device face (onboarding, restore, lock): cover panel | paper ----------
  const deviceFace = (opts: {
    art?: ArtSource;
    /** The paper's heading (Display). */
    title: string;
    lede?: string;
    /** Extra content on the cover panel (setup steps). */
    cover?: ReactNode;
    wide?: boolean;
    children: ReactNode;
    footnote?: string;
  }) => (
    <div className="ms-device-screen">
      <aside className="ms-device-cover">
        <span className="ms-device-cover__brand">
          {brandMark.src && <img className="ms-brand-img" src={brandMark.src} alt="" width={28} height={28} />}
          {dict.common.appName}
        </span>
        {opts.art && <Art src={opts.art} size={160} eager className="ms-device__art" />}
        <p className="ms-device-cover__promise">{sh.tagline}</p>
        {opts.cover}
      </aside>
      <div className="ms-device-paper">
        <section className={opts.wide ? 'ms-device ms-device--wide' : 'ms-device'} aria-labelledby="device-wordmark">
          <h1 id="device-wordmark" className="ms-device__wordmark">{opts.title}</h1>
          {opts.lede && <p className="ms-device__lede">{opts.lede}</p>}
          {opts.children}
          {opts.footnote && <p className="ms-device__foot">{opts.footnote}</p>}
        </section>
      </div>
    </div>
  );

  // ---------- Account sign-in gate ----------
  // Account sign-in comes FIRST — before vault onboarding / unlock —
  // and there is no way around it (no local-only mode). Without a known
  // account server the user is asked for one first. Sign-in never
  // unlocks the vault: after it, the user still faces the lock screen /
  // onboarding below.
  const gate = changingServer ? 'connect-server' : authGateStep(apiBaseUrl, signedIn);
  if (gate === 'connect-server' || !securityClient) {
    return frame(
      <ConnectServerScreen
        initialUrl={apiBaseUrl}
        onConnect={handleApiBaseUrlChange}
        onCancel={changingServer ? () => setChangingServer(false) : undefined}
      />,
    );
  }
  if (gate === 'sign-in') {
    return frame(
      <SignInScreen
        security={securityClient}
        sessionExpired={sessionExpired}
        onSignedIn={handleSignedIn}
        onChangeServer={() => setChangingServer(true)}
      />,
    );
  }

  // ---------- Onboarding (no vault yet, or still on the recovery-key / done steps) ----------
  // The vault exists and is unlocked as soon as createVault returns, but the
  // one-time recovery key must stay on screen until the user acknowledges it
  // (step 1) — gating on !vaultExists alone skipped that screen entirely.
  if (!vaultExists || onboardingStep !== 0) {
    const o = dict.onboarding;
    const strength = passphraseScore(newPass);
    const strengthLabel = dict.strength.levels[strength.score <= 2 ? 'weak' : strength.score <= 4 ? 'fair' : strength.score === 5 ? 'strong' : 'veryStrong'];
    const steps = [o.steps.create, o.steps.save, o.steps.done];
    const art = restoreUi
      ? restoreUi.count === null
        ? illustrations.restore
        : illustrations.restored
      : creating
        ? illustrations.working
        : onboardingStep === 0
          ? newPass
            ? illustrations.passphrase
            : illustrations.deviceHero
          : onboardingStep === 1
            ? illustrations.recoveryKey
            : illustrations.success;
    return frame(
      deviceFace({
        art,
        wide: true,
        title: restoreUi ? o.restoreFromBackup : onboardingStep === 2 ? o.readyTitle : steps[onboardingStep],
        lede: o.lede,
        cover: !restoreUi && (
          <ol className="ms-steps" aria-label={o.stepsLabel}>
            {steps.map((label, i) => (
              <li key={label} className="ms-steps__item" aria-current={i === onboardingStep ? 'step' : undefined} data-done={i < onboardingStep}>
                <span className="ms-steps__dot" aria-hidden="true">{i < onboardingStep ? <Icon name="check" size="md" /> : i + 1}</span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        ),
        children: (
          <>
            {restoreUi && restoreUi.count === null && <RestoreBackup onRestored={(count, itemList) => setRestoreUi({ count, itemList })} onCancel={() => setRestoreUi(null)} />}
            {restoreUi && restoreUi.count !== null && <RestoreSuccess itemCount={restoreUi.count} itemList={restoreUi.itemList} onContinue={() => { setRestoreUi(null); setVaultExists(true); }} />}
            {!restoreUi && (
              <>
                {onboardingStep === 0 && (
                  <form className="ms-device__body" onSubmit={(e) => { e.preventDefault(); void handleCreateVault(); }} noValidate>
                    <Field id="new-pass" label={o.passphrase} flush>
                      <SecureField name="master-passphrase" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder={o.passphrasePlaceholder} autoComplete="new-password" aria-label={o.passphrase} />
                    </Field>
                    <Field id="new-pass-confirm" label={o.confirm} flush>
                      <SecureField name="confirm-passphrase" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder={o.confirmPlaceholder} autoComplete="new-password" aria-label={o.confirm} />
                    </Field>
                    <div className="grid gap-1.5">
                      <div className="flex justify-between">
                        <span className="ms-legend">{o.strength}</span>
                        <span className="ms-legend ms-text-secondary">{newPass ? strengthLabel : '—'}</span>
                      </div>
                      <Progress
                        value={(strength.score / 6) * 100}
                        label={o.strength}
                        valueText={newPass ? strengthLabel : '—'}
                        tone={strength.score <= 2 ? 'danger' : strength.score <= 4 ? 'warning' : 'success'}
                      />
                    </div>
                    {onboardingError && <Alert tone="danger" announce>{onboardingError}</Alert>}
                    <Button type="submit" variant="primary" size="lg" block loading={creating}>
                      {creating ? o.creating : o.createVault}
                    </Button>
                    <Button block icon="restore" onClick={() => setRestoreUi({ count: null })}>
                      {o.restoreFromBackup}
                    </Button>
                  </form>
                )}

                {onboardingStep === 1 && (
                  <div className="ms-device__body">
                    <p className="m-0">
                      <strong>{o.saveTitle}</strong> <span className="ms-text-secondary">{o.saveBody}</span>
                    </p>
                    <div className="ms-secret-box font-mono">{recoveryKey}</div>
                    <div className="ms-device__pair">
                      <Button
                        icon={recoveryCopied ? 'check' : 'copy'}
                        onClick={() => {
                          void navigator.clipboard?.writeText(recoveryKey).catch(() => undefined);
                          setRecoveryCopied(true);
                        }}
                      >
                        {recoveryCopied ? o.copied : o.copyKey}
                      </Button>
                      <Button icon="export" aria-describedby="recovery-download-note" onClick={() => downloadText('my-secret-recovery-key.txt', `${recoveryKey}\n`, 'text/plain')}>
                        {o.downloadKey}
                      </Button>
                    </div>
                    <p id="recovery-download-note" className="ms-device__note">{o.downloadNote}</p>
                    <Checkbox checked={recoveryAck} onChange={(e) => setRecoveryAck(e.target.checked)} label={o.ack} />
                    <Button variant="primary" size="lg" block disabled={!recoveryAck} onClick={() => { setRecoveryKey(''); setRecoveryCopied(false); setRecoveryAck(false); setOnboardingStep(2); }}>
                      {o.done}
                    </Button>
                  </div>
                )}

                {onboardingStep === 2 && (
                  <div className="ms-device__body">
                    <p className="ms-text-secondary m-0">{o.readyBody}</p>
                    <Button variant="primary" size="lg" block icon="unlock" onClick={() => { setRecoveryKey(''); setOnboardingStep(0); setView('all'); setVaultExists(true); }}>
                      {o.openVault}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        ),
      }),
    );
  }

  // ---------- Lock screen: the device face ----------
  if (!unlocked) {
    const lk = dict.lock;
    return frame(
      deviceFace({
        art: unlocking ? illustrations.working : illustrations.splash,
        title: lk.status,
        lede: lk.lede,
        children: (
          <>
            <form className="ms-device__body" onSubmit={(e) => { e.preventDefault(); void handleUnlock(); }}>
              {useRecovery ? (
                <Field id="lock-recovery-key" label={lk.recoveryKey} flush>
                  <Input name="recovery-key" type="text" mono value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} placeholder={lk.recoveryPlaceholder} autoComplete="off" aria-label={lk.recoveryKey} autoFocus />
                </Field>
              ) : (
                <Field id="lock-passphrase" label={lk.passphrase} flush>
                  <SecureField name="master-passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="current-password" aria-label={lk.passphrase} autoFocus />
                </Field>
              )}
              {lockError && <Alert tone="danger" announce>{lockError}</Alert>}
              <Button type="submit" variant="primary" size="lg" block icon="unlock" loading={unlocking}>
                {useRecovery ? lk.unlockWithRecovery : lk.unlock}
              </Button>
            </form>
            <p className="mb-0 mt-3 text-center">
              <Button variant="link" onClick={() => { setUseRecovery((v) => !v); setLockError(''); }}>
                {useRecovery ? lk.usePassphrase : lk.useRecoveryKey}
              </Button>
            </p>
          </>
        ),
      }),
    );
  }

  // ---------- Unlocked shell: cover bar | spine + paper (ledger | page) ----------
  const syncLabel =
    sync.status.state === 'disabled'
      ? undefined
      : sync.status.state === 'idle'
        ? sh.syncState.ok
        : sync.status.state === 'syncing'
          ? sh.syncState.busy
          : sh.syncState.attention;
  const pushed = isListView && (showForm || selectedItem !== null);
  const closeDetail = () => { setSelectedId(null); setShowForm(false); setEditingItem(null); };
  const newItem = () => { if (!isListView) setView('all'); setEditingItem(null); setShowForm(true); };
  const rail = (inDrawer: boolean) => (
    <Sidebar
      view={view}
      setView={go}
      counts={counts}
      tags={tags}
      syncLabel={syncLabel}
      onLock={doLock}
      onExport={() => { setNavOpen(false); handleExport(); }}
      onImport={() => { setNavOpen(false); fileInputRef.current?.click(); }}
      onShowRecovery={() => { setNavOpen(false); setShowRecovery((v) => !v); }}
      inDrawer={inDrawer}
    />
  );
  const settingsTab = SETTINGS_VIEWS.includes(view);
  const tab = (key: keyof typeof sh.dock, icon: IconName, current: boolean, onClick: () => void) => (
    <button type="button" className="ms-dock__item" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} size="md" />
      <span>{sh.dock[key]}</span>
    </button>
  );
  const accountItems: MenuItemDef[] = [
    { key: 'security', label: sh.securityCenter, icon: 'shield', onSelect: () => go('security') },
    { key: 'settings', label: sh.settings, icon: 'settings', onSelect: () => go('settings') },
    { key: 'lock', label: sh.lockVault, icon: 'lock', onSelect: doLock },
    ...(signedIn ? [{ key: 'signout', label: dict.signin.signOut, icon: 'export' as const, onSelect: () => void handleSignOut() }] : []),
  ];

  const filterCount = filterCats.size + filterTags.size;
  const toggled = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const resetFilters = () => { setFilterCats(new Set()); setFilterTags(new Set()); };
  const emptyList = emptyListState();
  const viewRegion = { className: 'ms-content', role: 'region', 'aria-label': viewTitle, tabIndex: 0 } as const;

  return frame(
    <div className="ms-app" data-pushed={pushed} data-web={allowPlaintextExport ? undefined : 'true'}>
      <a href="#ms-main" className="ms-skip-link ms-button ms-button--primary">{sh.skipToContent}</a>
      <header className="ms-cover-bar">
        <div className="ms-cover-bar__lead">
          <IconButton className="ms-cover-bar__menu" icon="menu" label={sh.openMenu} onClick={() => setNavOpen(true)} />
          <span className="ms-cover-bar__brand">
            {brandMark.src && <img className="ms-brand-img" src={brandMark.src} alt="" width={28} height={28} />}
            <span className="ms-cover-bar__name">{dict.common.appName}</span>
          </span>
        </div>
        <nav className="ms-dock" aria-label={sh.phoneNav}>
          {tab('vault', 'lock', isListView, () => go('all'))}
          {tab('files', 'collections', view === 'media-gallery', () => go('media-gallery'))}
          {tab('generate', 'generate', view === 'generator', () => go('generator'))}
          {tab('health', 'shield', view === 'health', () => go('health'))}
          {tab('settings', 'settings', settingsTab, () => go('settings'))}
        </nav>
        <div className="ms-cover-bar__end">
          <button ref={searchButtonRef} type="button" className="ms-cover-search" aria-keyshortcuts="Meta+K Control+K" onClick={() => setShowPalette(true)}>
            <Icon name="search" size="md" />
            <span className="ms-cover-search__label">{sh.openSearch}</span>
            <Kbd>⌘K</Kbd>
          </button>
          <button type="button" className="ms-cover-new" aria-keyshortcuts="Meta+N Control+N" onClick={newItem}>
            <Icon name="add" size="md" />
            <span className="ms-cover-new__label">{sh.newItem}</span>
            <Kbd>⌘N</Kbd>
          </button>
          <IconButton className="ms-cover-bar__lock" icon="lock" label={sh.lockVault} onClick={doLock} />
          <DropdownMenu
            label={accountEmail || sh.localAccount}
            align="end"
            items={accountItems}
            trigger={
              // The name starts with the visible initials (WCAG 2.5.3 label in name).
              <button type="button" className="ms-avatar" aria-label={accountEmail ? `${accountEmail.slice(0, 2).toUpperCase()}, ${sh.account}` : sh.account}>
                <span>{accountEmail ? accountEmail.slice(0, 2).toUpperCase() : <Icon name="identity" size="md" />}</span>
              </button>
            }
          />
        </div>
      </header>
      {!allowPlaintextExport && (
        <div className="ms-webstrip" role="note">
          <Icon name="info" size="md" />
          <details>
            <summary>
              <span className="ms-webstrip__text">{dict.web.banner}</span> <span className="ms-webstrip__why">{dict.web.why}</span>
            </summary>
            <ul>
              <li>{dict.web.reasonCompromised}</li>
              <li>{dict.web.reasonAutofill}</li>
              <li>{dict.web.reasonUpload}</li>
              <li>{dict.web.reasonExport}</li>
              <li>{dict.web.reasonNarrow}</li>
            </ul>
          </details>
        </div>
      )}
      {rail(false)}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleImportFile(f);
          e.target.value = '';
        }}
      />

      <main id="ms-main" className="ms-main" tabIndex={-1}>
        <div className="ms-notices">
          {notice && (
            <Alert tone="info" announce action={<IconButton icon="close" size="sm" label={sh.dismiss} onClick={() => setNotice('')} />}>
              {notice}
            </Alert>
          )}
          {showRecovery && (
            <Alert tone="warning" title={sh.recoveryKey} action={<IconButton icon="close" size="sm" label={sh.close} onClick={() => setShowRecovery(false)} />}>
              {sh.recoveryNotice}
            </Alert>
          )}
          <SyncBar status={sync.status} conflicts={sync.conflicts} onSyncNow={sync.syncNow} onKeepBoth={sync.keepBoth} resolveError={sync.resolveError} />
        </div>

        {view === 'settings' ? (
          <div {...viewRegion}>
            <SettingsView
              autoLockMinutes={autoLockMinutes}
              onAutoLockChange={setAutoLockMinutes}
              itemCount={items.length}
              onExportEncrypted={handleExport}
              onExportPlaintext={handleExportPlaintext}
              allowPlaintextExport={allowPlaintextExport}
              onImport={() => fileInputRef.current?.click()}
              existingItems={items}
              onImportItems={handleImportItems}
              aiApiBaseUrl={signedIn ? securityClient?.baseUrl : undefined}
              onChangePassphrase={handleChangePassphraseRequest}
              onWipeVault={() => requestStepUp(handleWipeVault)}
              apiBaseUrl={apiBaseUrl}
              onChangeServer={() => setChangingServer(true)}
            />
          </div>
        ) : view === 'security' ? (
          <div {...viewRegion}>
            <SecurityCenter
              security={securityClient}
              apiBaseUrl={apiBaseUrl}
              encryptWithVaultKey={encryptWithVaultKey}
              decryptWithVaultKey={decryptWithVaultKey}
              signedInEmail={accountEmail}
              onSignOut={() => void handleSignOut()}
              onUnauthorized={handleUnauthorized}
              onAccountDeleted={handleAccountDeleted}
            />
          </div>
        ) : view === 'health' ? (
          <div {...viewRegion}>
            <div className="ms-view">
              <HealthView items={liveItems} onFix={(item) => { setView('all'); setSelectedId(item.id); setEditingItem(item); setShowForm(true); }} />
            </div>
          </div>
        ) : view === 'generator' ? (
          <div {...viewRegion}>
            <div className="ms-view ms-view--narrow grid gap-4">
              <div>
                <h2 className="ms-heading ms-heading--lg">{dict.generator.title}</h2>
                <p className="ms-text-sm ms-text-muted mb-0 mt-1 ms-prose">{dict.generator.lede}</p>
              </div>
              {generatedPassword && <Alert tone="success" announce>{dict.generator.usedNotice}</Alert>}
              <Card padding="lg">
                <PasswordGenerator onUse={(pw: string) => { setGeneratedPassword(pw); void copyWithClear('generator:use', pw); }} />
              </Card>
            </div>
          </div>
        ) : view === 'media-gallery' ? (
          <div {...viewRegion}>
            <MediaView
              items={items}
              api={mediaApi}
              onItemsChanged={() => setItems(listItems())}
              onSelect={(item) => { setView('all'); setSelectedId(item.id); setShowForm(false); setEditingItem(null); }}
            />
          </div>
        ) : view === 'shares' ? (
          <div {...viewRegion}>
            <SharesView
              apiBaseUrl={apiBaseUrl}
              signedIn={signedIn}
              getToken={() => getValidToken(webTokenStore())}
              items={items}
              encryptWithVaultKey={encryptWithVaultKey}
              decryptWithVaultKey={decryptWithVaultKey}
              onSaveItem={handleSaveSharedItem}
              onUnauthorized={handleUnauthorized}
            />
          </div>
        ) : (
          <div className="ms-content ms-content--split">
            <FilterPopover
              open={filterOpen}
              onClose={() => setFilterOpen(false)}
              anchorRef={filterButtonRef}
              categories={CATEGORIES.map((c) => ({
                key: c.key,
                label: categoryTitle(c.key),
                count: scopedItems.filter((i) => c.types.includes(i.type) && inTags(i, filterTags)).length,
              }))}
              tags={tags.map((tag) => ({
                key: tag,
                label: `#${tag}`,
                count: scopedItems.filter((i) => (i.tags ?? []).includes(tag) && inCategories(i, filterCats)).length,
              }))}
              selectedCategories={filterCats}
              selectedTags={filterTags}
              onToggleCategory={(key) => setFilterCats((prev) => toggled(prev, key))}
              onToggleTag={(tag) => setFilterTags((prev) => toggled(prev, tag))}
              onReset={resetFilters}
              shown={visibleItems.length}
              total={scopedItems.length}
            />
            <div className="ms-split" data-pushed={pushed}>
              <section className="ms-pane ms-pane--list" aria-label={viewTitle}>
                <div className="ms-pane__top">
                  <div className="ms-pane__head">
                    <h1 className="ms-pane__title">{viewTitle}</h1>
                    <button
                      ref={filterButtonRef}
                      type="button"
                      className="ms-filter-button"
                      aria-pressed={filterCount > 0}
                      aria-expanded={filterOpen}
                      aria-haspopup="dialog"
                      onClick={() => setFilterOpen((v) => !v)}
                    >
                      <Icon name="checklist" size="md" />
                      {sh.filter}
                      {filterCount > 0 && <span className="ms-filter-button__badge" aria-label={tp(sh.filterActive, filterCount)}>{filterCount}</span>}
                    </button>
                    <Button size="sm" variant="ghost" aria-pressed={selectionMode} onClick={() => { setSelectionMode((v) => !v); setBulkIds(new Set()); }}>
                      {selectionMode ? sh.doneSelecting : sh.selectMode}
                    </Button>
                  </div>
                  {filterCount > 0 && (
                    <div className="ms-tokens">
                      {[...filterCats].map((key) => (
                        <button key={`c:${key}`} type="button" className="ms-token" aria-label={format(sh.removeFilter, categoryTitle(key))} onClick={() => setFilterCats((prev) => toggled(prev, key))}>
                          {categoryTitle(key)}
                          <Icon name="close" size="md" />
                        </button>
                      ))}
                      {[...filterTags].map((tag) => (
                        <button key={`t:${tag}`} type="button" className="ms-token" aria-label={format(sh.removeFilter, `#${tag}`)} onClick={() => setFilterTags((prev) => toggled(prev, tag))}>
                          #{tag}
                          <Icon name="close" size="md" />
                        </button>
                      ))}
                      <Button variant="link" onClick={resetFilters}>{sh.clearAll}</Button>
                    </div>
                  )}
                  <span className="ms-input-wrap ms-search-field">
                    <span className="ms-search-field__icon" aria-hidden="true"><Icon name="search" /></span>
                    <input
                      id="search-items"
                      name="search"
                      type="search"
                      className="ms-input"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={sh.searchPlaceholder}
                      aria-label={sh.searchLabel}
                      autoComplete="off"
                    />
                  </span>
                  <div className="ms-pane__toolbar">
                    {selectionMode ? (
                      <>
                        <Button size="sm" onClick={() => setBulkIds(new Set(visibleItems.map((i) => i.id)))}>{sh.selectAll}</Button>
                        <span className="ms-pane__count">{tp(sh.selectedCount, bulkIds.size)}</span>
                      </>
                    ) : (
                      <>
                        <span className="ms-pane__count">
                          {filterCount > 0 ? tp(sh.filteredCount, scopedItems.length, visibleItems.length) : tp(sh.itemCount, visibleItems.length)}
                        </span>
                        <span className="ms-sort">
                          <Icon name="sort" size="md" />
                          <select id="header-sort" name="sort" aria-label={sh.sortLabel} value={sort} onChange={(e) => setSort(e.target.value as ItemSort)}>
                            <option value="title">{sh.sortTitle}</option>
                            <option value="updated">{sh.sortUpdated}</option>
                            <option value="created">{sh.sortCreated}</option>
                          </select>
                        </span>
                      </>
                    )}
                    {selectionMode && bulkIds.size > 0 && (
                      <div className="flex w-full flex-wrap gap-2">
                        {view !== 'trash' && <Button size="sm" icon="favorite" onClick={() => void handleBulkFavorite()}>{sh.bulkFavorite}</Button>}
                        {view === 'trash' ? (
                          <>
                            <Button size="sm" icon="restore" onClick={() => void handleBulkRestore()}>{sh.bulkRestore}</Button>
                            <Button size="sm" variant="danger" icon="trash" onClick={() => void handleBulkDelete()}>{sh.bulkDeleteForever}</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="danger-outline" icon="trash" onClick={() => void handleBulkDelete()}>{sh.bulkMoveToTrash}</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setBulkIds(new Set())}>{sh.clearSelection}</Button>
                      </div>
                    )}
                  </div>
                </div>
                {visibleItems.length === 0 ? (
                  <EmptyState
                    art={emptyList.art}
                    title={emptyList.title}
                    body={emptyList.body}
                    primaryAction={items.length === 0 && view !== 'trash' ? { label: sh.loadExample, icon: 'add', onClick: () => void handleLoadExampleData() } : undefined}
                    secondaryAction={items.some(isExampleItem) ? { label: sh.clearExample, icon: 'trash', onClick: handleClearExampleData } : undefined}
                    note={items.length === 0 && view !== 'trash' ? sh.exampleNote : undefined}
                  />
                ) : (
                  <ItemList
                    items={visibleItems}
                    selectedId={selectedId}
                    onSelect={(id: string) => { setSelectedId(id); setShowForm(false); setEditingItem(null); }}
                    letters={sort === 'title' && !searchQuery.trim()}
                    selectionMode={selectionMode}
                    selectedIds={bulkIds}
                    onToggleSelect={(id: string) => {
                      setBulkIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id); else next.add(id);
                        return next;
                      });
                    }}
                  />
                )}
              </section>

              <section className="ms-pane ms-pane--detail" aria-label={showForm ? (editingItem ? dict.itemForm.editTitle : dict.itemForm.newTitle) : selectedItem ? selectedItem.title : sh.selectPromptTitle}>
                {pushed && (
                  <Button variant="ghost" icon="back" className="ms-pane__back" onClick={closeDetail}>
                    {sh.backToList}
                  </Button>
                )}
                {showForm ? (
                  <ItemForm
                    initial={editingItem ?? undefined}
                    allItems={items}
                    onSave={handleSaveItem}
                    onCancel={() => { setShowForm(false); setEditingItem(null); }}
                    onAutosave={(item: VaultItem) => void handleAutosaveItem(item)}
                  />
                ) : selectedItem ? (
                  <ItemDetail
                    key={selectedItem.id}
                    item={selectedItem}
                    allItems={items}
                    onEdit={(item: VaultItem) => { setEditingItem(item); setShowForm(true); }}
                    onDelete={() => handleDelete(selectedItem.id)}
                    onRestore={() => handleRestore(selectedItem.id)}
                    onToggleFavorite={() => handleToggleFavorite(selectedItem.id)}
                    onSelectRelated={(id) => { setSelectedId(id); setShowForm(false); setEditingItem(null); }}
                    onArchive={(id) => void handleArchive(id)}
                    onRestoreRevision={(item: VaultItem) => void handleRestoreRevision(item)}
                  />
                ) : (
                  <EmptyState
                    art={illustrations.selectItem}
                    title={sh.selectPromptTitle}
                    body={sh.selectPrompt}
                    note={
                      <>
                        {sh.shortcuts}
                        {items.length === 0 && <><br />{sh.exampleLoadNote}</>}
                      </>
                    }
                    // The empty list already offers the one primary action outside Trash.
                    primaryAction={items.length === 0 && view === 'trash' ? { label: sh.loadExample, icon: 'add', onClick: () => void handleLoadExampleData() } : undefined}
                    secondaryAction={items.some(isExampleItem) ? { label: sh.clearExample, icon: 'trash', onClick: handleClearExampleData } : undefined}
                  />
                )}
              </section>
            </div>
          </div>
        )}

        {copiedKey && (
          <div className="ms-copy-toast" role="status">
            <Icon name="success" size="lg" />
            {format(dict.itemDetail.copied, secondsLeft)}
          </div>
        )}
      </main>

      <Sheet side="left" flush hideTitle title={sh.navLabel} open={navOpen} onOpenChange={setNavOpen}>
        {rail(true)}
      </Sheet>

      <SearchPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        returnFocusRef={searchButtonRef}
        items={items}
        onSelect={(item) => {
          setSelectedId(item.id);
          setView('all');
          setShowForm(false);
          setEditingItem(null);
        }}
      />
      <StepUpDialog
        open={stepUpOpen}
        security={securityClient}
        verifyPassphrase={verifyPassphrase}
        reason={stepUpReason}
        onVerified={() => handleStepUpVerified()}
        onCancel={handleStepUpCancel}
      />
      {keyTurn && (
        <div className="ms-keyturn" aria-hidden="true">
          {deviceFace({ title: dict.lock.working, children: <div className="ms-device__body" /> })}
        </div>
      )}
    </div>,
  );
}
