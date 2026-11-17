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
import { parseEncryptedExportText } from '../../../packages/import-export/src/index';
import type { VaultShare, SharePermission } from '../../../packages/core/src/sharing';
import { revokeShare } from '../../../packages/core/src/sharing';
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
import MediaView from './components/MediaView';
import SharesView from './components/SharesView';
import SecurityCenter from './components/SecurityCenter';
import StepUpDialog from './components/StepUpDialog';
import { useSync } from './sync/useSync';
import SyncBar from './sync/SyncBar';
import SignInScreen from './components/SignInScreen';
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
import { afterUnauthorized, shouldShowSignInGate } from './authGate';
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
  Kbd,
  Led,
  LedStrip,
  Progress,
  SecureField,
  Select,
  Sheet,
  brandMark,
  copyWithClear,
  illustrations,
  initTheme,
  type IconName,
  type LedStripState,
  type LedTone,
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
const LS_SHARES = 'my-secrect.local-vault.share-proposals.v1';
/** API base URL for the account server. Empty = local-only: no
 *  SecurityApiClient is constructed and the Security Center shows its
 *  not-configured state. The server never sees vault content. */
const LS_API_BASE_URL = 'my-secrect:api-base-url';

/** Share proposals are PENDING only — no key envelope exists, so no share
 *  is ever active. See SharesView / handleCreateShare. */
function loadShares(): VaultShare[] {
  try {
    const raw = localStorage.getItem(LS_SHARES);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is VaultShare =>
        typeof s === 'object' && s !== null &&
        typeof (s as VaultShare).id === 'string' &&
        typeof (s as VaultShare).recipient_id === 'string' &&
        ((s as VaultShare).status === 'pending' || (s as VaultShare).status === 'revoked' || (s as VaultShare).status === 'active'))
      // Defence in depth: this build has no key-exchange, so a stored
      // 'active' share cannot have an envelope — downgrade it to pending
      // rather than ever displaying an active share.
      .map((s) => (s.status === 'active' ? { ...s, status: 'pending' as const } : s));
  } catch {
    return [];
  }
}

function newShareId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'share_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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

export default function App({ allowPlaintextExport = true }: { allowPlaintextExport?: boolean } = {}) {
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
  const [generatedPassword, setGeneratedPassword] = useState('');
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
  const [restoreUi, setRestoreUi] = useState<null | { count: number | null }>(null);
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [onboardingError, setOnboardingError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lockTimerRef = useRef<number | null>(null);
  // Sharing: pending proposals only (no key exchange — see loadShares).
  const [shares, setShares] = useState<VaultShare[]>(() => loadShares());
  // List sorting + bulk selection.
  const [sort, setSort] = useState<ItemSort>('updated');
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkIds, setBulkIds] = useState<Set<string>>(new Set());
  // Account server (local-first): the client exists only when a base URL
  // is configured. The token getter reads the stored account session
  // token, if a sign-in flow has stored one; otherwise calls go out
  // without Authorization and the server answers 401.
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_API_BASE_URL) ?? '';
    } catch {
      return '';
    }
  });
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
  // gate below shows SignInScreen before the vault whenever a server
  // is configured and there is no valid session. Vault unlock
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
  // 'Continue without signing in' — local-only escape hatch so a
  // configured-but-unreachable server can never brick the local
  // vault. Account features stay signed out until sign-in succeeds.
  const [localOnlyBypass, setLocalOnlyBypass] = useState(false);
  // Set when a server call answers 401: the gate reappears with a
  // 'session expired' note instead of silently retrying.
  const [sessionExpired, setSessionExpired] = useState(false);

  const handleSignedIn = useCallback((email: string) => {
    setAccountEmail(email);
    setSignedIn(true);
    setLocalOnlyBypass(false);
    setSessionExpired(false);
  }, []);

  // The server confirmed account deletion: drop the (now dead) session and
  // email and return to the sign-in gate. The local vault is NOT erased.
  const handleAccountDeleted = useCallback(() => {
    void clearSessionToken(webTokenStore());
    try { localStorage.removeItem(LS_ACCOUNT_EMAIL); } catch { /* non-critical */ }
    setAccountEmail('');
    setSignedIn(false);
    setLocalOnlyBypass(false);
    setSessionExpired(false);
  }, []);

  // Mirror of the local-only choice for callbacks created once (handleUnauthorized).
  const localOnlyBypassRef = useRef(localOnlyBypass);
  localOnlyBypassRef.current = localOnlyBypass;
  const handleUnauthorized = useCallback(() => {
    // A 401 means the stored session is gone server-side (revoked
    // or expired). Clear it locally and send the user back to
    // SignIn; never retry with the same stale token. A user who chose
    // local-only keeps that choice for the session (afterUnauthorized).
    void clearSessionToken(webTokenStore());
    const next = afterUnauthorized({ signedIn: false, localOnlyBypass: localOnlyBypassRef.current, sessionExpired: false });
    setSignedIn(next.signedIn);
    setLocalOnlyBypass(next.localOnlyBypass);
    setSessionExpired(next.sessionExpired);
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
    setApiBaseUrl(url);
    // A stored token belongs to the previous server (if any): a
    // changed URL always requires signing in again. Clearing the URL
    // returns to local-only, where the sign-in gate is off.
    setSignedIn(false);
    setLocalOnlyBypass(false);
    setSessionExpired(false);
    try {
      const trimmed = url.trim();
      if (trimmed) localStorage.setItem(LS_API_BASE_URL, trimmed);
      else localStorage.removeItem(LS_API_BASE_URL);
    } catch {
      // API URL persistence is non-critical; a full localStorage must not break the vault.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_SHARES, JSON.stringify(shares));
    } catch {
      // Share proposals are non-critical; a full localStorage must not break the vault.
    }
  }, [shares]);

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
    enabled: signedIn && unlocked && !localOnlyBypass,
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
    setLocalOnlyBypass(false);
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

  const visibleItems = useMemo(() => {
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
    const sorted = [...base];
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'created') sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    else sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sorted;
  }, [view, liveItems, archivedItems, trash, searchQuery, sort]);

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

  const handleSaveItem = async (item: VaultItem) => {
    await upsertItem(item);
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
  const doExportEncrypted = () => {
    try {
      const blob = new Blob([exportEncrypted()], { type: 'application/json' });
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
    requestStepUp(doExportEncrypted, { reason: 'export' });
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
      await importEncrypted(text);
      refresh();
      const after = listItems(true);
      const newCount = after.filter((i) => !beforeIds.has(i.id)).length;
      setNotice(
        format(dict.notices.backupImported, tp(dict.notices.fileItems, validation.itemCount), tp(dict.notices.newItems, newCount)) +
          (validation.warnings.length > 0 ? ` ${format(dict.notices.importNote, validation.warnings.join(' '))}` : ''),
      );
    } catch (err) {
      setNotice(err instanceof Error ? format(dict.notices.importFailedWith, err.message) : dict.notices.importFailed);
    }
  };

  const handleImportCsv = async (csvItems: VaultItem[]) => {
    for (const item of csvItems) await upsertItem(item);
    refresh();
    setNotice(tp(dict.notices.csvImported, csvItems.length));
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

  /**
   * Sharing: record a PENDING proposal only. No key envelope is created
   * and no share becomes active — HPKE / sealed-box key exchange is not
   * implemented (see SharesView). A proposal that claimed to be active
   * would be a lie; the UI shows every proposal as pending.
   */
  const handleCreateShare = (proposal: { recipient_id: string; permission: SharePermission; item_ids: string[] }) => {
    const share: VaultShare = {
      id: newShareId(),
      vault_id: 'local',
      owner_id: 'local',
      recipient_id: proposal.recipient_id,
      recipient_label_encrypted: null,
      permission: proposal.permission,
      status: 'pending',
      key_envelope_id: '',
      item_ids: proposal.item_ids,
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    setShares((prev) => [...prev, share]);
    setNotice(dict.notices.shareSaved);
  };

  const handleRevokeShare = (share: VaultShare) => {
    setShares((prev) => prev.map((s) => (s.id === share.id ? revokeShare(s) : s)));
    setNotice(dict.notices.shareRevoked);
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

  // ---------- Device face (sign-in gate aside: onboarding, restore, lock) ----------
  const deviceFace = (opts: {
    art?: ArtSource;
    artWideOnly?: boolean;
    led: LedStripState;
    lede?: string;
    wide?: boolean;
    children: ReactNode;
    footnote?: string;
  }) => (
    <div className="ms-device-screen">
      <div className="ms-device-stage">
        {opts.art && (
          <Art src={opts.art} size={240} eager className={opts.artWideOnly ? 'ms-device__art ms-device__art--wide' : 'ms-device__art'} />
        )}
        <section className={opts.wide ? 'ms-device ms-device--wide' : 'ms-device'} aria-labelledby="device-wordmark">
          <div className="ms-device__head">
            {brandMark.src && <img src={brandMark.src} alt="" width={40} height={40} />}
            <h1 id="device-wordmark" className="ms-device__wordmark">{dict.common.appName}</h1>
            <LedStrip state={opts.led} />
          </div>
          {opts.lede && <p className="ms-device__lede">{opts.lede}</p>}
          {opts.children}
          {opts.footnote && <p className="ms-device__foot">{opts.footnote}</p>}
        </section>
      </div>
    </div>
  );

  // ---------- Account sign-in gate ----------
  // When a server is configured and there is no valid session, the
  // account sign-in comes FIRST — before vault onboarding / unlock.
  // The vault itself stays local-first: 'Continue without signing
  // in' skips the gate and the vault works offline, with account
  // features signed out. With no server configured there is no gate
  // at all. Sign-in never unlocks the vault: after it, the user
  // still faces the lock screen / onboarding below.
  if (securityClient && shouldShowSignInGate(true, { signedIn, localOnlyBypass, sessionExpired })) {
    return frame(
      <SignInScreen
        security={securityClient}
        sessionExpired={sessionExpired}
        onSignedIn={handleSignedIn}
        onContinueLocalOnly={() => setLocalOnlyBypass(true)}
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
        led: onboardingStep === 2 || restoreUi?.count != null ? 'open' : creating ? 'working' : 'locked',
        lede: o.lede,
        footnote: o.footnote,
        children: (
          <>
            {restoreUi && restoreUi.count === null && <RestoreBackup onRestored={(count) => setRestoreUi({ count })} onCancel={() => setRestoreUi(null)} />}
            {restoreUi && restoreUi.count !== null && <RestoreSuccess itemCount={restoreUi.count} onContinue={() => { setRestoreUi(null); setVaultExists(true); }} />}
            {!restoreUi && (
              <>
                <ol className="ms-steps" aria-label={o.stepsLabel}>
                  {steps.map((label, i) => (
                    <li key={label} className="ms-steps__item" aria-current={i === onboardingStep ? 'step' : undefined}>
                      <Led tone={i === onboardingStep ? 'active' : i < onboardingStep ? 'ok' : 'off'} />
                      <span className="ms-legend">{label}</span>
                    </li>
                  ))}
                </ol>

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
                    <Button
                      block
                      icon={recoveryCopied ? 'check' : 'copy'}
                      onClick={() => {
                        void navigator.clipboard?.writeText(recoveryKey).catch(() => undefined);
                        setRecoveryCopied(true);
                      }}
                    >
                      {recoveryCopied ? o.copied : o.copyKey}
                    </Button>
                    <Checkbox checked={recoveryAck} onChange={(e) => setRecoveryAck(e.target.checked)} label={o.ack} />
                    <Button variant="primary" size="lg" block disabled={!recoveryAck} onClick={() => { setRecoveryKey(''); setRecoveryCopied(false); setRecoveryAck(false); setOnboardingStep(2); }}>
                      {o.done}
                    </Button>
                  </div>
                )}

                {onboardingStep === 2 && (
                  <div className="ms-device__body text-center">
                    <h2 className="ms-heading ms-heading--lg">{o.readyTitle}</h2>
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
        artWideOnly: true,
        led: unlocking ? 'working' : lockError ? 'error' : 'locked',
        children: (
          <>
            <p className="ms-device__lede">
              <strong className="ms-text-secondary">{lk.status}</strong>
              <br />
              {lk.lede}
            </p>
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

  // ---------- Unlocked shell: rail | topbar + content | phone tab bar ----------
  const syncTone: LedTone | null =
    sync.status.state === 'disabled'
      ? null
      : sync.status.state === 'idle'
        ? 'ok'
        : sync.status.state === 'syncing'
          ? 'active'
          : sync.status.state === 'offline'
            ? 'attention'
            : 'danger';
  const syncLabel =
    sync.status.state === 'idle'
      ? sh.syncState.ok
      : sync.status.state === 'syncing'
        ? sh.syncState.busy
        : sync.status.state === 'disabled'
          ? sh.syncState.off
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
      healthScore={liveItems.length > 0 ? health.score : undefined}
      onLock={doLock}
      onExport={() => { setNavOpen(false); handleExport(); }}
      onImport={() => { setNavOpen(false); fileInputRef.current?.click(); }}
      onShowRecovery={() => { setNavOpen(false); setShowRecovery((v) => !v); }}
      inDrawer={inDrawer}
    />
  );
  const tab = (key: 'vault' | 'search' | 'generator' | 'watchtower' | 'settings', icon: IconName, current: boolean, onClick: () => void) => (
    <button type="button" className="ms-tabbar__item" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} size="lg" />
      <span>{sh.tabs[key]}</span>
    </button>
  );

  const emptyList = emptyListState();
  const viewRegion = { className: 'ms-content', role: 'region', 'aria-label': viewTitle, tabIndex: 0 } as const;

  return frame(
    <div className="ms-app" data-pushed={pushed}>
      <a href="#ms-main" className="ms-skip-link ms-button ms-button--primary">{sh.skipToContent}</a>
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
        <header className="ms-topbar">
          <IconButton className="ms-topbar__menu" icon="menu" label={sh.openMenu} variant="secondary" onClick={() => setNavOpen(true)} />
          <h1 className="ms-heading ms-heading--md ms-topbar__title">{viewTitle}</h1>
          {isListView && (
            <div className="ms-topbar__search">
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
                <button type="button" className="ms-input-wrap__button" aria-label={`${sh.openSearch} ⌘K`} title={sh.openSearch} onClick={() => setShowPalette(true)}>
                  <Kbd>⌘K</Kbd>
                </button>
              </span>
            </div>
          )}
          <div className="ms-topbar__end">
            {syncTone && (
              <span className="ms-copy-led ms-legend ms-topbar__wide">
                <Led tone={syncTone} /> {syncLabel}
              </span>
            )}
            <Button variant="primary" onClick={newItem}>{sh.newItem}</Button>
            <IconButton className="ms-topbar__phone" icon="lock" label={sh.lockVault} variant="secondary" onClick={doLock} />
          </div>
        </header>

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
              onImportCsv={(csvItems) => void handleImportCsv(csvItems)}
              onChangePassphrase={handleChangePassphraseRequest}
              onWipeVault={() => requestStepUp(handleWipeVault)}
              apiBaseUrl={apiBaseUrl}
              onApiBaseUrlChange={handleApiBaseUrlChange}
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
            <SharesView shares={shares} onCreate={handleCreateShare} onRevoke={handleRevokeShare} />
          </div>
        ) : (
          <div className="ms-content ms-content--split">
            <div className="ms-split" data-pushed={pushed}>
              <section className="ms-pane ms-pane--list" aria-label={viewTitle}>
                <div className="ms-pane__toolbar">
                  <Button size="sm" aria-pressed={selectionMode} onClick={() => { setSelectionMode((v) => !v); setBulkIds(new Set()); }}>
                    {selectionMode ? sh.doneSelecting : sh.selectMode}
                  </Button>
                  {selectionMode ? (
                    <>
                      <Button size="sm" onClick={() => setBulkIds(new Set(visibleItems.map((i) => i.id)))}>{sh.selectAll}</Button>
                      <span className="ms-legend">{tp(sh.selectedCount, bulkIds.size)}</span>
                    </>
                  ) : (
                    <span className="ml-auto flex min-w-0 items-center gap-2">
                      <Icon name="sort" size="sm" className="ms-text-muted" />
                      <Select id="header-sort" name="sort" aria-label={sh.sortLabel} value={sort} onChange={(e) => setSort(e.target.value as ItemSort)}>
                        <option value="updated">{sh.sortUpdated}</option>
                        <option value="created">{sh.sortCreated}</option>
                        <option value="title">{sh.sortTitle}</option>
                      </Select>
                    </span>
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
                    onToggleFavorite={handleToggleFavorite}
                    onDelete={handleDelete}
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
                    onSave={(item: VaultItem) => void handleSaveItem(item)}
                    onCancel={() => { setShowForm(false); setEditingItem(null); }}
                    onAutosave={(item: VaultItem) => void handleAutosaveItem(item)}
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
                    primaryAction={items.length === 0 ? { label: sh.loadExample, icon: 'add', onClick: () => void handleLoadExampleData() } : undefined}
                    secondaryAction={items.some(isExampleItem) ? { label: sh.clearExample, icon: 'trash', onClick: handleClearExampleData } : undefined}
                  />
                )}
              </section>
            </div>
          </div>
        )}

        <nav className="ms-tabbar" aria-label={sh.phoneNav}>
          {tab('vault', 'items', isListView, () => go('all'))}
          {tab('search', 'search', false, () => setShowPalette(true))}
          {tab('generator', 'generate', view === 'generator', () => go('generator'))}
          {tab('watchtower', 'health', view === 'health', () => go('health'))}
          {tab('settings', 'settings', view === 'settings', () => go('settings'))}
        </nav>
      </main>

      <Sheet side="left" flush hideTitle title={sh.navLabel} open={navOpen} onOpenChange={setNavOpen}>
        {rail(true)}
      </Sheet>

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
          {deviceFace({ led: 'turn', children: <div className="ms-device__body" /> })}
        </div>
      )}
    </div>,
  );
}
