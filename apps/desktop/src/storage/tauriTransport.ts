/**
 * Real `KvTransport` to the Rust store in src-tauri/src/lib.rs.
 *
 * - startup read: synchronous XHR to `vaultkv://localhost/snapshot`
 *   (`http://vaultkv.localhost/snapshot` on Windows). The storage contract is
 *   synchronous and the vault reads it during the first render, while Tauri
 *   commands are async-only. Read-only; answered only for the main window
 *   from the app's own origins.
 * - every later read/write: the `kv_snapshot` / `kv_commit` commands, the
 *   only two commands the capability allows.
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import { parseSnapshot, StorageUnavailableError, type KvOp, type KvSnapshot, type KvTransport } from './backend';

export const SNAPSHOT_SCHEME = 'vaultkv';

function serverError(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error;
    }
  } catch {
    // not JSON
  }
  return null;
}

export function createTauriTransport(): KvTransport {
  return {
    loadSnapshotSync(): KvSnapshot {
      const xhr = new XMLHttpRequest();
      // Synchronous on purpose (see header); runs once, before React mounts.
      xhr.open('GET', convertFileSrc('snapshot', SNAPSHOT_SCHEME), false);
      xhr.send();
      if (xhr.status !== 200) {
        throw new StorageUnavailableError(
          serverError(xhr.responseText) ?? `snapshot request failed (HTTP ${xhr.status})`,
        );
      }
      return parseSnapshot(JSON.parse(xhr.responseText));
    },
    async readSnapshot(): Promise<KvSnapshot> {
      return parseSnapshot(await invoke<unknown>('kv_snapshot'));
    },
    commit(expectedGeneration: number, ops: KvOp[]): Promise<number> {
      return invoke<number>('kv_commit', { expectedGeneration, ops });
    },
  };
}
