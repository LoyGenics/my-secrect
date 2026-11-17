import { useCallback, useEffect, useRef, useState } from 'react';
import { clearSessionToken, getValidToken, webTokenStore } from '../../../../packages/sdk/src/security';
import type { SyncConflict } from '../../../../packages/sync/src/index';
import { SyncEngine, type SyncStatus } from './engine';

export interface UseSyncOptions {
  /** True only while signed in AND the vault is unlocked. Auth and unlock stay separate gates. */
  enabled: boolean;
  /** API base URL including the `/api` prefix. */
  apiBaseUrl: string;
  accountEmail: string;
  onItemsChanged: () => void;
  onUnauthorized: () => void;
}

export interface UseSync {
  status: SyncStatus;
  conflicts: SyncConflict[];
  syncNow: () => void;
  keepBoth: (conflictId: string) => Promise<void>;
  /** Visible error from a resolve attempt (never swallowed). */
  resolveError: string | null;
}

const DISABLED: SyncStatus = { state: 'disabled', error: null, lastSyncedAt: null, pending: 0, unresolvedConflicts: 0 };

/** Lifecycle of the SyncEngine: starts after sign-in + unlock, stops on lock / sign-out. */
export function useSync(opts: UseSyncOptions): UseSync {
  const [status, setStatus] = useState<SyncStatus>(DISABLED);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    if (!opts.enabled || !opts.apiBaseUrl.trim() || !opts.accountEmail) {
      setStatus(DISABLED);
      setConflicts([]);
      return;
    }
    const store = webTokenStore();
    const engine = new SyncEngine({
      baseUrl: opts.apiBaseUrl.trim(),
      getToken: () => getValidToken(store),
      accountKey: opts.accountEmail,
      onItemsChanged: () => cb.current.onItemsChanged(),
      clearToken: () => clearSessionToken(store),
      onUnauthorized: () => cb.current.onUnauthorized(),
      onStatus: (s) => {
        setStatus(s);
        setConflicts(engine.getConflicts());
      },
    });
    engineRef.current = engine;
    engine.start().catch((err: unknown) => {
      setStatus({ ...DISABLED, state: 'error', error: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      engine.stop();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [opts.enabled, opts.apiBaseUrl, opts.accountEmail]);

  const syncNow = useCallback(() => { void engineRef.current?.syncNow(); }, []);
  const keepBoth = useCallback(async (id: string) => {
    setResolveError(null);
    try {
      await engineRef.current?.resolveKeepBoth(id);
      setConflicts(engineRef.current?.getConflicts() ?? []);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { status, conflicts, syncNow, keepBoth, resolveError };
}
