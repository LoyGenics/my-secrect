/**
 * The three production vault modules behind one interface, each on its own
 * in-memory host storage — exactly the host API the module uses in its app:
 *   desktop/web  apps/desktop/src/vault.ts        -> globalThis.localStorage
 *   extension    apps/extension/src/lib/vault-ext.ts -> chrome.storage.local
 *   mobile       apps/mobile/src/vault.ts         -> vault.db (SQLite; sql.js here, SQLCipher on a phone)
 * Only the storage host is substituted; crypto (libsodium), backup format,
 * validation and restore logic are the unmodified production modules.
 */
import type { VaultItem } from '../../../packages/core/src/types';
import { useSqlJsMobilePlatform, type MobileHostStorage } from '../../../apps/mobile/tests/support/node-mobile-platform';

export type RestoreSecret = { passphrase: string } | { recoveryKey: string };

export interface VaultTarget {
  name: 'desktop' | 'extension' | 'mobile';
  create(passphrase: string): Promise<{ recoveryKey: string }>;
  unlock(passphrase: string): Promise<boolean>;
  unlockRecovery(recoveryKey: string): Promise<boolean>;
  upsert(item: VaultItem): Promise<void>;
  trash(id: string): Promise<void>;
  exportBackup(): Promise<string>;
  restore(json: string, secret: RestoreSecret): Promise<void>;
  /** Every decrypted item in memory, trash included. */
  items(): VaultItem[];
  lock(): void;
  wipe(): Promise<void>;
  isUnlocked(): boolean;
  /** Canonical dump of the raw host storage (vault keys only). */
  snapshot(): string;
}

const sorted = (m: Map<string, unknown>) => JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));

// ---------------------------------------------------------------- desktop
const desktopStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => (desktopStore.has(k) ? desktopStore.get(k)! : null),
    setItem: (k: string, v: string) => { desktopStore.set(k, String(v)); },
    removeItem: (k: string) => { desktopStore.delete(k); },
    clear: () => desktopStore.clear(),
    key: (i: number) => [...desktopStore.keys()][i] ?? null,
    get length() { return desktopStore.size; },
  },
});

// ---------------------------------------------------------------- extension
const extStore = new Map<string, unknown>();
const keyList = (k: string | string[] | null | undefined): string[] => (k == null ? [...extStore.keys()] : Array.isArray(k) ? k : [k]);
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(k?: string | string[] | null) {
        const out: Record<string, unknown> = {};
        for (const key of keyList(k)) if (extStore.has(key)) out[key] = structuredClone(extStore.get(key));
        return out;
      },
      async set(obj: Record<string, unknown>) { for (const [key, v] of Object.entries(obj)) extStore.set(key, structuredClone(v)); },
      async remove(k: string | string[]) { for (const key of keyList(k)) extStore.delete(key); },
    },
  },
};

// ---------------------------------------------------------------- mobile
// One vault.db per process, like the one Map per host above. The mobile
// vault reaches it through setVaultPlatform (sql.js store, empty legacy
// AsyncStorage, software DeviceKey) instead of expo-sqlite.
let mobileStore: MobileHostStorage = { size: 0, snapshot: () => '[]' };
let mobileReady: Promise<void> | null = null;

export async function loadTargets(): Promise<Record<VaultTarget['name'], VaultTarget>> {
  const d = await import('../../../apps/desktop/src/vault.ts');
  const e = await import('../../../apps/extension/src/lib/vault-ext.ts');
  const m = await import('../../../apps/mobile/src/vault.ts');
  mobileReady ??= useSqlJsMobilePlatform(m).then((host) => { mobileStore = host; });
  await mobileReady;
  const desktop: VaultTarget = {
    name: 'desktop',
    create: (p) => d.createVault(p),
    unlock: (p) => d.unlockVault(p),
    unlockRecovery: (k) => d.unlockWithRecoveryKey(k),
    upsert: (i) => d.upsertItem(i),
    trash: async (id) => { d.deleteItem(id); },
    exportBackup: async () => d.exportEncrypted(),
    restore: (json, s) => d.restoreEncrypted(json, s as never),
    items: () => d.listItems(true),
    lock: () => d.lockVault(),
    wipe: async () => { d.wipeVault(); },
    isUnlocked: () => d.isUnlocked(),
    snapshot: () => sorted(desktopStore),
  };
  const extension: VaultTarget = {
    name: 'extension',
    create: (p) => e.createVault(p),
    unlock: (p) => e.unlockVault(p),
    unlockRecovery: (k) => e.unlockWithRecoveryKey(k),
    upsert: (i) => e.upsertItem(i),
    trash: (id) => e.softDeleteItem(id),
    exportBackup: () => e.exportEncrypted(),
    restore: (json, s) => e.restoreEncrypted(json, s as never),
    items: () => e.listUnlockedItems(),
    lock: () => e.lockVault(),
    wipe: () => e.wipeVault(),
    isUnlocked: () => e.isUnlocked(),
    snapshot: () => sorted(extStore),
  };
  const mobile: VaultTarget = {
    name: 'mobile',
    create: (p) => m.createVault(p),
    unlock: (p) => m.unlockVault(p),
    unlockRecovery: (k) => m.unlockWithRecoveryKey(k),
    upsert: (i) => m.upsertItem(i),
    trash: (id) => m.deleteItem(id),
    exportBackup: () => m.exportEncrypted(),
    restore: (json, s) => m.restoreEncrypted(json, s as never),
    items: () => m.listItems(true),
    lock: () => m.lockVault(),
    wipe: () => m.wipeVault(),
    isUnlocked: () => m.isUnlocked(),
    snapshot: () => mobileStore.snapshot(),
  };
  return { desktop, extension, mobile };
}

/** Raw host storage sizes, to assert "nothing was written". */
export function storeSizes() {
  return { desktop: desktopStore.size, extension: extStore.size, mobile: mobileStore.size };
}
