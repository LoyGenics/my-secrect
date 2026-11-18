/**
 * vault.db — the on-device store defined by specs/mobile-local-store.md §2.
 * It holds only what the AsyncStorage build held (encrypted rows + the
 * wrapped-key JSON) plus the device-unlock wrap and the autofill index.
 * No plaintext vault content and no unwrapped key is ever written here.
 */
import type { SerializedSql, SqlExecutor } from './sql';

export const SCHEMA_VERSION = '1';

// Verbatim from the frozen contract; the credential providers read it.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_keys (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  id               TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL,
  nonce            TEXT NOT NULL,
  ciphertext       TEXT NOT NULL,
  wrapped_item_key TEXT NOT NULL,
  wrapped_nonce    TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE TABLE IF NOT EXISTS device_unlock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  scheme       TEXT NOT NULL,
  wrapped_amk  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS autofill_index (
  id       TEXT PRIMARY KEY,
  title    TEXT NOT NULL,
  username TEXT NOT NULL,
  host     TEXT NOT NULL,
  type     TEXT NOT NULL
);
`;

export interface StoredRow {
  id: string; revision: number; nonce: string; ciphertext: string;
  wrapped_item_key: string; wrapped_nonce: string; deleted_at?: string | null;
}

// Additive app-only table. Credential providers continue to use the contract above.
const LOCAL_CARD_CODES_SQL = 'CREATE TABLE IF NOT EXISTS local_card_codes (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)';
export interface StoredKeys {
  salt: string; wrapped_master: string; wrapped_master_nonce: string;
  wrapped_vault: string; wrapped_vault_nonce: string;
  wrapped_recovery: string; wrapped_recovery_nonce: string;
}
export interface DeviceUnlockRow { scheme: string; wrapped_amk: string; created_at: string }
export interface AutofillEntry { id: string; title: string; username: string; host: string; type: 'login' | 'passkey' }

const ROW_COLUMNS = 'id, revision, nonce, ciphertext, wrapped_item_key, wrapped_nonce, deleted_at';

async function insertRow(tx: SqlExecutor, r: StoredRow): Promise<void> {
  await tx.run(
    `INSERT OR REPLACE INTO rows (${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [r.id, r.revision, r.nonce, r.ciphertext, r.wrapped_item_key, r.wrapped_nonce, r.deleted_at ?? null],
  );
}
async function putIndexEntry(tx: SqlExecutor, id: string, entry: AutofillEntry | null): Promise<void> {
  if (!entry) { await tx.run('DELETE FROM autofill_index WHERE id = ?', [id]); return; }
  await tx.run(
    'INSERT OR REPLACE INTO autofill_index (id, title, username, host, type) VALUES (?, ?, ?, ?, ?)',
    [entry.id, entry.title, entry.username, entry.host, entry.type],
  );
}
async function replaceIndex(tx: SqlExecutor, entries: readonly AutofillEntry[]): Promise<void> {
  await tx.run('DELETE FROM autofill_index');
  for (const e of entries) await putIndexEntry(tx, e.id, e);
}
async function isOccupiedTx(tx: SqlExecutor): Promise<boolean> {
  const keys = await tx.first<{ n: number }>('SELECT count(*) AS n FROM vault_keys');
  const rows = await tx.first<{ n: number }>('SELECT count(*) AS n FROM rows');
  return (keys?.n ?? 0) > 0 || (rows?.n ?? 0) > 0;
}
async function countRows(tx: SqlExecutor): Promise<number> {
  return (await tx.first<{ n: number }>('SELECT count(*) AS n FROM rows'))?.n ?? 0;
}
function sameRow(a: StoredRow, b: StoredRow): boolean {
  return a.id === b.id && a.revision === b.revision && a.nonce === b.nonce && a.ciphertext === b.ciphertext
    && a.wrapped_item_key === b.wrapped_item_key && a.wrapped_nonce === b.wrapped_nonce
    && (a.deleted_at ?? null) === (b.deleted_at ?? null);
}

export class VaultStore {
  private constructor(private readonly db: SerializedSql) {}

  /** Create the contract tables if missing and refuse an unknown schema. */
  static async open(db: SerializedSql): Promise<VaultStore> {
    await db.transaction(async (tx) => {
      await tx.exec(SCHEMA_SQL);
      await tx.exec(LOCAL_CARD_CODES_SQL);
      const v = await tx.first<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
      if (!v) await tx.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
      else if (v.value !== SCHEMA_VERSION) throw new Error(`vault.db schema_version ${v.value} is not supported by this build`);
    });
    return new VaultStore(db);
  }

  async getKeysJson(): Promise<string | null> {
    return (await this.db.first<{ json: string }>('SELECT json FROM vault_keys WHERE id = 1'))?.json ?? null;
  }
  async getKeys(): Promise<StoredKeys | null> {
    const raw = await this.getKeysJson(); if (raw === null) return null;
    try { return JSON.parse(raw) as StoredKeys; } catch { return null; }
  }
  async listRows(): Promise<StoredRow[]> {
    return this.db.all<StoredRow>(`SELECT ${ROW_COLUMNS} FROM rows ORDER BY rowid`);
  }
  async isOccupied(): Promise<boolean> { return this.db.transaction(isOccupiedTx); }

  async getLocalCardCode(id: string): Promise<string | null> {
    return (await this.db.first<{ ciphertext: string }>('SELECT ciphertext FROM local_card_codes WHERE id = ?', [id]))?.ciphertext ?? null;
  }

  /** New vault: fresh keys, and nothing left over from an earlier one. */
  async createVault(keysJson: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM rows');
      await tx.run('DELETE FROM local_card_codes');
      await tx.run('DELETE FROM device_unlock');
      await tx.run('DELETE FROM autofill_index');
      await tx.run('INSERT OR REPLACE INTO vault_keys (id, json) VALUES (1, ?)', [keysJson]);
    });
  }

  /** Passphrase change: new key envelope; the device-unlock wrap and the autofill index go with it (contract §2, §4). */
  async replaceKeysAndDropDeviceUnlock(keysJson: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('UPDATE vault_keys SET json = ? WHERE id = 1', [keysJson]);
      await tx.run('DELETE FROM device_unlock');
      await tx.run('DELETE FROM autofill_index');
    });
  }

  /** Write one item row (revision = stored + 1) and its index entry together. */
  async upsertItemRow(row: Omit<StoredRow, 'revision'>, entry: AutofillEntry | null, localCardCode?: string | null): Promise<number> {
    return this.db.transaction(async (tx) => {
      const prev = await tx.first<{ revision: number }>('SELECT revision FROM rows WHERE id = ?', [row.id]);
      const revision = (prev?.revision ?? 0) + 1;
      await insertRow(tx, { ...row, revision });
      await putIndexEntry(tx, row.id, entry);
      if (localCardCode === null) await tx.run('DELETE FROM local_card_codes WHERE id = ?', [row.id]);
      else if (localCardCode !== undefined) {
        await tx.run('INSERT OR REPLACE INTO local_card_codes (id, ciphertext) VALUES (?, ?)', [row.id, localCardCode]);
      }
      return revision;
    });
  }
  async insertImportedItems(
    items: readonly { row: Omit<StoredRow, 'revision'>; entry: AutofillEntry | null }[],
    assertUnlocked: () => void,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      assertUnlocked();
      const autofill = await tx.first('SELECT id FROM device_unlock WHERE id = 1');
      for (const { row, entry } of items) {
        assertUnlocked();
        if (await tx.first('SELECT id FROM rows WHERE id = ?', [row.id])) throw new Error('Imported item already exists');
        await insertRow(tx, { ...row, revision: 1 });
        await putIndexEntry(tx, row.id, autofill ? entry : null);
      }
      assertUnlocked();
    });
  }
  async setDeletedAt(id: string, deletedAt: string | null, entry: AutofillEntry | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('UPDATE rows SET deleted_at = ? WHERE id = ?', [deletedAt, id]);
      await putIndexEntry(tx, id, entry);
    });
  }
  async deleteRow(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM rows WHERE id = ?', [id]);
      await tx.run('DELETE FROM local_card_codes WHERE id = ?', [id]);
      await tx.run('DELETE FROM autofill_index WHERE id = ?', [id]);
    });
  }
  /** Import merge: the accepted rows and the rebuilt index land in one transaction. */
  async mergeRows(rows: readonly StoredRow[], index: readonly AutofillEntry[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const r of rows) await insertRow(tx, r);
      await replaceIndex(tx, index);
    });
  }
  /** Restore from backup: only into an empty store, all or nothing. */
  async restoreVault(keysJson: string, rows: readonly StoredRow[], index: readonly AutofillEntry[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (await isOccupiedTx(tx)) throw new Error('restore: vault storage is not empty');
      await tx.run('INSERT INTO vault_keys (id, json) VALUES (1, ?)', [keysJson]);
      for (const r of rows) await insertRow(tx, r);
      await replaceIndex(tx, index);
    });
  }

  async getDeviceUnlock(): Promise<DeviceUnlockRow | null> {
    return this.db.first<DeviceUnlockRow>('SELECT scheme, wrapped_amk, created_at FROM device_unlock WHERE id = 1');
  }
  async putDeviceUnlock(row: DeviceUnlockRow): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO device_unlock (id, scheme, wrapped_amk, created_at) VALUES (1, ?, ?, ?)',
      [row.scheme, row.wrapped_amk, row.created_at],
    );
  }
  /** Biometric unlock off: the wrap row and the autofill index are removed together (contract §2). */
  async deleteDeviceUnlock(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM device_unlock');
      await tx.run('DELETE FROM autofill_index');
    });
  }

  async listAutofillIndex(): Promise<AutofillEntry[]> {
    return this.db.all<AutofillEntry>('SELECT id, title, username, host, type FROM autofill_index ORDER BY id');
  }
  async replaceAutofillIndex(entries: readonly AutofillEntry[]): Promise<void> {
    await this.db.transaction((tx) => replaceIndex(tx, entries));
  }

  /** Wipe: every vault table emptied in one transaction (meta keeps the schema version). */
  async wipe(): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const t of ['vault_keys', 'rows', 'device_unlock', 'autofill_index', 'local_card_codes']) await tx.run(`DELETE FROM ${t}`);
    });
  }

  /**
   * One-time copy from the AsyncStorage build (contract §2 "Migration").
   * Empty store: insert keys + rows, then check the row count before
   * COMMIT. Non-empty store: only accepted when it already holds exactly
   * this data (an earlier run committed but could not delete the
   * AsyncStorage keys). Anything else throws and rolls back.
   */
  async importLegacy(keysJson: string | null, rows: readonly StoredRow[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (await isOccupiedTx(tx)) {
        const existingKeys = (await tx.first<{ json: string }>('SELECT json FROM vault_keys WHERE id = 1'))?.json ?? null;
        if (keysJson !== null && existingKeys !== keysJson) throw new Error('migration: vault.db already holds a different vault');
        for (const r of rows) {
          const got = await tx.first<StoredRow>(`SELECT ${ROW_COLUMNS} FROM rows WHERE id = ?`, [r.id]);
          if (!got || !sameRow(got, r)) throw new Error('migration: vault.db already holds a different vault');
        }
        return;
      }
      if (keysJson !== null) await tx.run('INSERT INTO vault_keys (id, json) VALUES (1, ?)', [keysJson]);
      for (const r of rows) {
        await tx.run(
          `INSERT INTO rows (${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [r.id, r.revision, r.nonce, r.ciphertext, r.wrapped_item_key, r.wrapped_nonce, r.deleted_at ?? null],
        );
      }
      const n = await countRows(tx);
      if (n !== rows.length) throw new Error(`migration: copied ${n} rows, expected ${rows.length}`);
    });
  }
  async countRows(): Promise<number> { return this.db.transaction(countRows); }
}
