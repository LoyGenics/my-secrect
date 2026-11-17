/**
 * Real SQLite (sql.js: the SQLite C library compiled to WASM) behind the
 * same SqlExecutor seam expo-sqlite fills on a phone. No SQLCipher here:
 * these tests cover the SQL, transactions and migration, not encryption
 * at rest — that is checked on the simulator / emulator.
 */
import initSqlJs from 'sql.js';
import { SerializedSql, type SqlExecutor, type SqlValue } from '../../src/storage/sql';
import { VaultStore } from '../../src/storage/vaultStore';

interface SqlJsStatement { bind(values: SqlValue[]): void; step(): boolean; getAsObject(): Record<string, unknown>; free(): void }
interface SqlJsDatabase { exec(sql: string): unknown; run(sql: string, params?: SqlValue[]): void; prepare(sql: string): SqlJsStatement; export(): Uint8Array }

export interface TestDb { raw: SqlExecutor; sql: SerializedSql; db: SqlJsDatabase }

export async function openTestDb(): Promise<TestDb> {
  const SQL = await (initSqlJs as unknown as () => Promise<{ Database: new () => SqlJsDatabase }>)();
  const db = new SQL.Database();
  const all = async <T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind([...params]);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally { stmt.free(); }
  };
  const raw: SqlExecutor = {
    exec: async (sql) => { db.exec(sql); },
    run: async (sql, params = []) => { db.run(sql, [...params]); },
    all,
    first: async <T>(sql: string, params: readonly SqlValue[] = []) => (await all<T>(sql, params))[0] ?? null,
  };
  return { raw, sql: new SerializedSql(raw), db };
}

export async function openTestStore(): Promise<TestDb & { store: VaultStore }> {
  const t = await openTestDb();
  return { ...t, store: await VaultStore.open(t.sql) };
}

/** AsyncStorage stand-in for the legacy keys; `failRemove` simulates a crash before cleanup. */
export class MemoryKeyValue {
  readonly map = new Map<string, string>();
  failRemove = false;
  async getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  async setItem(k: string, v: string) { this.map.set(k, v); }
  async removeItem(k: string) { if (this.failRemove) throw new Error('removeItem failed'); this.map.delete(k); }
}
