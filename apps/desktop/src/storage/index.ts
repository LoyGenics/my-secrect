/**
 * Storage backend selection for the vault.
 *
 * - Inside the Tauri desktop app: `TauriSqlcipherBackend` (SQLCipher file,
 *   key in the OS credential store), after a one-time move of the vault's
 *   localStorage keys into it. If the store cannot be opened the app stops
 *   with a visible error — it never falls back to localStorage.
 * - Anywhere else (the web client, tests): the given fallback, i.e. the
 *   existing localStorage backend, unchanged.
 */
import { isTauri } from '@tauri-apps/api/core';

import { StorageUnavailableError, TauriSqlcipherBackend, toUnavailable, type KvTransport, type StorageBackend } from './backend';
import { startLegacyMigration, type MigrationReport } from './migration';
import { createTauriTransport } from './tauriTransport';

export { StorageUnavailableError, TauriSqlcipherBackend } from './backend';
export type { KvOp, KvSnapshot, KvTransport, StorageBackend } from './backend';
export { startLegacyMigration } from './migration';
export type { MigrationReport } from './migration';

export interface SelectStorageOptions {
  /** Backend used outside Tauri; inside Tauri it is only the migration source. */
  fallback: () => StorageBackend;
  /** localStorage keys owned by the vault, moved into SQLCipher once. */
  migrateKeys: readonly string[];
}

/** Environment hooks; the default is the real Tauri runtime. */
export interface StorageRuntime {
  isTauri(): boolean;
  transport(): KvTransport;
  /** The store failed (startup or a later write): tell the user, stop the app. */
  reportFatal(error: StorageUnavailableError): void;
  migrationFinished(report: MigrationReport): void;
}

/** Tauri v2 sets `isTauri` (official API) and `__TAURI_INTERNALS__` in its webviews. */
export function isTauriRuntime(): boolean {
  if (isTauri()) return true;
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Full-window alert drawn without React (the app may not be mounted).
 * English only: it is shown before any UI/i18n is available.
 */
export function showStorageAlert(error: Error): void {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
    'padding:32px;background:#0B0F14;color:#f4f4f5;font:14px/1.6 system-ui,sans-serif;' +
    'white-space:pre-wrap;text-align:center;overflow:auto';
  el.textContent =
    'my-secrect stopped: its encrypted storage is unavailable.\n\n' +
    `${error.message}\n\n` +
    'Changes after this point were NOT saved. Quit and reopen the app. ' +
    'Nothing was written to unencrypted storage.';
  (document.body ?? document.documentElement).appendChild(el);
}

export const tauriRuntime: StorageRuntime = {
  isTauri: isTauriRuntime,
  transport: createTauriTransport,
  reportFatal(error) {
    console.error('[storage]', error);
    showStorageAlert(error);
  },
  migrationFinished(report) {
    if (report.status === 'none' || report.status === 'migrated') return;
    // Data is safe in every non-success case (localStorage copy kept), but say so.
    console.warn('[storage] localStorage -> SQLCipher migration:', report);
  },
};

export function selectStorageBackend(
  options: SelectStorageOptions,
  runtime: StorageRuntime = tauriRuntime,
): StorageBackend {
  if (!runtime.isTauri()) return options.fallback();

  const legacy = options.fallback();
  let backend: TauriSqlcipherBackend;
  try {
    backend = new TauriSqlcipherBackend(runtime.transport(), (error) => runtime.reportFatal(error));
  } catch (err) {
    const error = toUnavailable('could not open the encrypted vault store', err);
    runtime.reportFatal(error);
    throw error;
  }
  void startLegacyMigration(legacy, backend, options.migrateKeys).then((report) =>
    runtime.migrationFinished(report),
  );
  return backend;
}
