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
import { I18nProvider } from '../../../packages/i18n/src/react';
import { detectLocale } from '../../../packages/i18n/src/index';

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

  const handleUnauthorized = useCallback(() => {
    // A 401 means the stored session is gone server-side (revoked
    // or expired). Clear it locally and send the user back to
    // SignIn; never retry with the same stale token.
    void clearSessionToken(webTokenStore());
    setSignedIn(false);
    setLocalOnlyBypass(false);
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
      setNotice('Encrypted backup downloaded. It stays encrypted — keep it safe.');
    } catch {
      setNotice('Export failed.');
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
      setNotice('Plaintext export is disabled on the web client — encrypted-only export is available here. Use the desktop app for a plaintext export.');
      return;
    }
    try {
      // SettingsView already required the explicit acknowledgement checkbox.
      downloadText(`my-secrect-plaintext-export-${new Date().toISOString().slice(0, 10)}.json`, exportPlaintext(), 'application/json');
      setNotice('Plaintext export downloaded. Delete it as soon as you are done — it contains all your secrets in readable form.');
    } catch {
      setNotice('Plaintext export failed.');
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
              setNotice('Passphrase changed.');
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
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNotice('Import failed: could not read the file.');
      return;
    }
    // Validate BEFORE touching the vault: wrong format, newer/older
    // version, malformed rows and plaintext files are all rejected here
    // with a specific message instead of a generic failure.
    const { validation } = parseEncryptedExportText(text);
    if (!validation.ok) {
      setNotice(`Import failed: ${validation.errors.join(' ')}`);
      return;
    }
    const beforeIds = new Set(listItems(true).map((i) => i.id));
    try {
      // importEncrypted requires an unlocked vault and merges rows by id,
      // keeping the higher revision; rows this vault cannot decrypt
      // (wrong key / tampered AEAD tag) are skipped, never stored.
      await importEncrypted(text);
      refresh();
      const after = listItems(true);
      const newCount = after.filter((i) => !beforeIds.has(i.id)).length;
      setNotice(
        `Backup imported: ${validation.itemCount} item(s) in file, ${newCount} new item(s) added. ` +
          'Rows with an older revision, or that this vault cannot decrypt (wrong key or tampered file), were skipped.' +
          (validation.warnings.length > 0 ? ` Note: ${validation.warnings.join(' ')}` : ''),
      );
    } catch (err) {
      setNotice(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed.');
    }
  };

  const handleImportCsv = async (csvItems: VaultItem[]) => {
    for (const item of csvItems) await upsertItem(item);
    refresh();
    setNotice(`Imported ${csvItems.length} login(s) from CSV. They are tagged “imported”.`);
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
    setNotice(archived ? 'Item unarchived — back in All Items.' : 'Item archived — find it under Archived.');
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
    setNotice('Note restored to the selected revision. The previous version was kept in revision history.');
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
    setNotice('Share proposal saved locally as PENDING — no key was exchanged and no share is active. Sharing is not production-ready until HPKE key exchange is implemented.');
  };

  const handleRevokeShare = (share: VaultShare) => {
    setShares((prev) => prev.map((s) => (s.id === share.id ? revokeShare(s) : s)));
    setNotice('Share revoked. Revocation removes the proposal — it does not erase copies a recipient already decrypted.');
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
    setNotice(`${ids.length} item(s) added to favorites.`);
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
    setNotice(view === 'trash' ? `${ids.length} item(s) permanently deleted.` : `${ids.length} item(s) moved to trash.`);
  };

  const handleBulkRestore = async () => {
    const ids = [...bulkIds];
    for (const id of ids) restoreItem(id);
    setBulkIds(new Set());
    setSelectionMode(false);
    refresh();
    setNotice(`${ids.length} item(s) restored from trash.`);
  };

  const viewTitle =
    view === 'all'
      ? 'All Items'
      : view === 'favorites'
        ? 'Favorites'
        : view === 'trash'
          ? 'Trash'
          : view === 'archived'
            ? 'Archived'
            : view === 'media-gallery'
              ? 'Media gallery'
              : view === 'shares'
                ? 'Sharing'
                : view === 'health'
                  ? 'Security Health'
                  : view === 'settings'
                    ? 'Settings'
                    : view === 'security'
                      ? 'Security Center'
              : view.startsWith('tag:')
              ? `#${view.slice(4)}`
              : (CATEGORIES.find((c) => c.key === view)?.label ?? 'Vault');

  const emptyMessage =
    view === 'trash'
      ? 'Trash is empty. Deleted items are kept here until you permanently delete them.'
      : view === 'archived'
        ? 'Nothing archived. Archive an item from its detail view to hide it here without deleting it.'
        : view === 'favorites'
        ? 'No favorites yet. Star an item to pin it here.'
        : view === 'health'
          ? 'No items to check yet.'
          : view.startsWith('tag:')
            ? `No items tagged “${view.slice(4)}”.`
            : 'No items in this view yet. Press Cmd/Ctrl+N to add one.';

  // ---------- Account sign-in gate ----------
  // When a server is configured and there is no valid session, the
  // account sign-in comes FIRST — before vault onboarding / unlock.
  // The vault itself stays local-first: 'Continue without signing
  // in' skips the gate and the vault works offline, with account
  // features signed out. With no server configured there is no gate
  // at all. Sign-in never unlocks the vault: after it, the user
  // still faces the lock screen / onboarding below.
  if (securityClient && !signedIn && !localOnlyBypass) {
    return (
      <I18nProvider initialLocale={detectLocale()}>
        <SignInScreen
          security={securityClient}
          sessionExpired={sessionExpired}
          onSignedIn={handleSignedIn}
          onContinueLocalOnly={() => setLocalOnlyBypass(true)}
        />
      </I18nProvider>
    );
  }

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
  // I18nProvider (browser-detected locale) covers only the components
  // that read it — SecurityCenter and StepUpDialog. The rest of the
  // shell keeps its hardcoded English strings.
  return (
    <I18nProvider initialLocale={detectLocale()}>
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
            <label className="flex items-center gap-1.5 text-xs text-zinc-400" htmlFor="header-sort">
              Sort
              <select id="header-sort" name="sort" aria-label="Sort items" value={sort} onChange={(e) => setSort(e.target.value as ItemSort)} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                <option value="updated">Recently updated</option>
                <option value="created">Newest first</option>
                <option value="title">Title A–Z</option>
              </select>
            </label>
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SecurityCenter
              security={securityClient}
              apiBaseUrl={apiBaseUrl}
              encryptWithVaultKey={encryptWithVaultKey}
              decryptWithVaultKey={decryptWithVaultKey}
              requestStepUp={requestStepUp}
              signedInEmail={accountEmail}
              onSignOut={() => void handleSignOut()}
              onUnauthorized={handleUnauthorized}
            />
          </div>
        ) : view === 'health' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <HealthView items={liveItems} onFix={(item) => { setView('all'); setSelectedId(item.id); setEditingItem(item); setShowForm(true); }} />
          </div>
        ) : view === 'media-gallery' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MediaView
              items={items}
              manifests={{}}
              thumbnailUrls={{}}
              onSelect={(item) => { setView('all'); setSelectedId(item.id); setShowForm(false); setEditingItem(null); }}
              onRequestDownload={() => setNotice('Download is not available yet: this prototype stores only the file manifest (name, type, size, SHA-256). File bytes are not stored, so there is nothing to download.')}
            />
          </div>
        ) : view === 'shares' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SharesView shares={shares} onCreate={handleCreateShare} onRevoke={handleRevokeShare} />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1">
          <section className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800 p-3">
            <div className="mb-2 flex items-center gap-2">
              <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => { setSelectionMode((v) => !v); setBulkIds(new Set()); }}>
                {selectionMode ? 'Done selecting' : 'Select'}
              </button>
              {selectionMode && (
                <>
                  <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setBulkIds(new Set(visibleItems.map((i) => i.id)))}>All</button>
                  <span className="text-xs text-zinc-400">{bulkIds.size} selected</span>
                </>
              )}
            </div>
            {selectionMode && bulkIds.size > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                {view !== 'trash' && (
                  <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleBulkFavorite()}>★ Favorite</button>
                )}
                {view === 'trash' ? (
                  <>
                    <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleBulkRestore()}>Restore</button>
                    <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleBulkDelete()}>Delete forever</button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleBulkDelete()}>Move to trash</button>
                )}
                <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setBulkIds(new Set())}>Clear</button>
              </div>
            )}
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

          <section className="min-w-0 flex-1 overflow-y-auto p-5">
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
      <StepUpDialog
        open={stepUpOpen}
        security={securityClient}
        verifyPassphrase={verifyPassphrase}
        reason={stepUpReason}
        onVerified={() => handleStepUpVerified()}
        onCancel={handleStepUpCancel}
      />
    </div>
    </I18nProvider>
  );
}
