/**
 * Loads the REAL vault modules of the three TypeScript apps — desktop
 * (apps/desktop/src/vault.ts), extension (apps/extension/src/lib/vault-ext.ts)
 * and mobile (apps/mobile/src/vault.ts) — into one Node process, for the
 * cross-implementation test and the TS fixture generator.
 *
 * Only each app's PLATFORM STORAGE is replaced, with an in-memory map:
 *  - desktop:   globalThis.localStorage
 *  - extension: globalThis.chrome.storage.local
 *  - mobile:    '@react-native-async-storage/async-storage', intercepted in
 *               Module._load (apps/mobile has no "type": "module", so tsx
 *               loads vault.ts as CJS and the bare require goes through it).
 * The crypto, key hierarchy, export and restore code under test is the
 * production code, unmodified. Same approach as apps/desktop/portable-restore.test.ts,
 * apps/extension/vault-ext-restore.test.ts and apps/mobile/vault-restore.test.ts.
 */
import { createRequire } from 'node:module';

export const storage = {
  desktop: new Map<string, string>(),
  extension: new Map<string, unknown>(),
  mobile: new Map<string, string>(),
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

  const mobile = storage.mobile;
  const asyncStorage = {
    async getItem(k: string) { return mobile.has(k) ? mobile.get(k)! : null; },
    async setItem(k: string, v: string) { mobile.set(k, String(v)); },
    async removeItem(k: string) { mobile.delete(k); },
  };
  const ASYNC_STORAGE = '@react-native-async-storage/async-storage';
  const cjs = createRequire(import.meta.url)('node:module') as {
    _load: (request: string, ...rest: unknown[]) => unknown;
  };
  const originalLoad = cjs._load;
  cjs._load = function (request: string, ...rest: unknown[]) {
    if (request === ASYNC_STORAGE) return { __esModule: true, default: asyncStorage };
    return originalLoad.call(this, request, ...rest);
  };
}

export async function loadAppVaults() {
  installShims();
  const desktop = await import('../../../../apps/desktop/src/vault.ts');
  const extension = await import('../../../../apps/extension/src/lib/vault-ext.ts');
  const mobile = await import('../../../../apps/mobile/src/vault.ts');
  return { desktop, extension, mobile };
}
