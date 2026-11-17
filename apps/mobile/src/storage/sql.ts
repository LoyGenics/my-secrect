/**
 * The small async SQL surface the vault store needs. On a phone it is
 * backed by expo-sqlite (SQLCipher build, see nativePlatform.ts); the
 * Node tests back it with sql.js, a real SQLite compiled to WASM.
 */
export type SqlValue = string | number | null;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
}

/**
 * Runs every statement and transaction on one connection, one at a time.
 * A transaction holds the queue from BEGIN IMMEDIATE to COMMIT, so no
 * other statement can land inside it, and any throw rolls it back: a
 * multi-row write is either fully on disk or not at all.
 */
export class SerializedSql implements SqlExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly raw: SqlExecutor) {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }

  exec(sql: string): Promise<void> { return this.enqueue(() => this.raw.exec(sql)); }
  run(sql: string, params?: readonly SqlValue[]): Promise<void> { return this.enqueue(() => this.raw.run(sql, params)); }
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> { return this.enqueue(() => this.raw.all<T>(sql, params)); }
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null> { return this.enqueue(() => this.raw.first<T>(sql, params)); }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.raw);
        await this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        await this.raw.exec('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }
}
