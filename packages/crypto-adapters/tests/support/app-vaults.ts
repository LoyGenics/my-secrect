/**
 * Loads the REAL vault modules of the three TypeScript apps — desktop
 * (apps/desktop/src/vault.ts), extension (apps/extension/src/lib/vault-ext.ts)
 * and mobile (apps/mobile/src/vault.ts) — into one Node process, for the
 * cross-implementation test and the TS fixture generator.
 *
 * Only each app's PLATFORM STORAGE is replaced:
 *  - desktop:   globalThis.localStorage (in-memory map)
 *  - extension: globalThis.chrome.storage.local (in-memory map)
 *  - mobile:    vault.db on sql.js (real SQLite) through setVaultPlatform,
 *               see apps/mobile/tests/support/node-mobile-platform.ts
 * The crypto, key hierarchy, export and restore code under test is the
 * production code, unmodified. Same approach as apps/desktop/portable-restore.test.ts,
 * apps/extension/vault-ext-restore.test.ts and apps/mobile/vault-restore.test.ts.
 */
import { useSqlJsMobilePlatform, type MobileHostStorage } from '../../../../apps/mobile/tests/support/node-mobile-platform';

let mobileHost: MobileHostStorage | null = null;
let mobileReady: Promise<void> | null = null;

export const storage = {
  desktop: new Map<string, string>(),
  extension: new Map<string, unknown>(),
  /** Rows in the mobile vault tables (0 = nothing stored). */
  mobile: { get size() { return mobileHost?.size ?? 0; } },
};

let installed = false;

function installShims(): void {
  if (installed) return;
  installed = true;

  const desktop = storage.desktop;
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (desktop.has(k) ? desktop.get(k)! : null),
      setItem: (k: string, v: string) => { desktop.set(k, String(v)); },
      removeItem: (k: string) => { desktop.delete(k); },
      clear: () => { desktop.clear(); },
      key: (i: number) => [...desktop.keys()][i] ?? null,
      get length() { return desktop.size; },
    },
    configurable: true,
    writable: true,
  });

  const ext = storage.extension;
  const keyList = (k: string | string[] | null | undefined): string[] =>
    k == null ? [...ext.keys()] : Array.isArray(k) ? k : [k];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(k?: string | string[] | null) {
          const out: Record<string, unknown> = {};
          for (const key of keyList(k)) if (ext.has(key)) out[key] = structuredClone(ext.get(key));
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [key, v] of Object.entries(obj)) ext.set(key, structuredClone(v));
        },
        async remove(k: string | string[]) {
          for (const key of keyList(k)) ext.delete(key);
        },
      },
    },
  };

}

export async function loadAppVaults() {
  installShims();
  const desktop = await import('../../../../apps/desktop/src/vault.ts');
  const extension = await import('../../../../apps/extension/src/lib/vault-ext.ts');
  const mobile = await import('../../../../apps/mobile/src/vault.ts');
  mobileReady ??= useSqlJsMobilePlatform(mobile).then((host) => { mobileHost = host; });
  await mobileReady;
  return { desktop, extension, mobile };
}
