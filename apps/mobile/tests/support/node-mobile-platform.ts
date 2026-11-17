/**
 * Runs the REAL apps/mobile/src/vault.ts in Node for suites outside
 * apps/mobile (packages/crypto-adapters cross-impl, tests/acceptance): its
 * vault.db is a sql.js database (real SQLite, no SQLCipher), the legacy
 * AsyncStorage is empty and DeviceKey is the software stand-in. Only the
 * platform is substituted; crypto, backup and restore code are unmodified.
 *
 * `size` and `snapshot()` read the vault tables synchronously (sql.js is
 * synchronous underneath) so callers can keep "nothing was written" and
 * "storage unchanged" assertions. meta (schema_version) is not vault data
 * and is left out, so an empty vault is size 0 and snapshot '[]'.
 */
import type { VaultPlatform } from '../../src/storage/platform';
import { MemoryKeyValue, openTestStore } from './sqljs';
import { SoftwareDeviceKey } from './softwareDeviceKey';

const VAULT_TABLES = ['vault_keys', 'rows', 'device_unlock', 'autofill_index'] as const;

export interface MobileHostStorage {
  /** Rows across the vault tables. */
  readonly size: number;
  /** Canonical, sorted dump of every vault-table row. */
  snapshot(): string;
}

export async function useSqlJsMobilePlatform(vault: { setVaultPlatform(p: VaultPlatform): void }): Promise<MobileHostStorage> {
  const t = await openTestStore();
  vault.setVaultPlatform({ openStore: async () => t.store, legacy: new MemoryKeyValue(), deviceKey: new SoftwareDeviceKey() });
  const rowsOf = (table: string): Array<Record<string, unknown>> => {
    const stmt = t.db.prepare(`SELECT * FROM ${table}`);
    try {
      const out: Array<Record<string, unknown>> = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally { stmt.free(); }
  };
  const entries = (): Array<[string, Record<string, unknown>]> =>
    VAULT_TABLES.flatMap((table) => rowsOf(table).map((r) => [`${table}:${String(r.id)}`, r] as [string, Record<string, unknown>]));
  return {
    get size() { return entries().length; },
    snapshot: () => JSON.stringify(entries().sort(([a], [b]) => a.localeCompare(b))),
  };
}
