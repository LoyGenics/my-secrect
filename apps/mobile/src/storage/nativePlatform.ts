/**
 * Device wiring for vault.ts: vault.db through expo-sqlite built with
 * SQLCipher (app.json `useSQLCipher`), keyed with the Local Storage Key
 * from the DeviceKey module, in the contract §1 directory. Loaded lazily
 * by vault.ts so Node tests never import native code.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import DeviceKey from '../../modules/device-key';
import { SerializedSql, type SqlExecutor, type SqlValue } from './sql';
import { VaultStore } from './vaultStore';
import type { VaultPlatform } from './platform';

export const DB_NAME = 'vault.db';

function executor(db: SQLite.SQLiteDatabase): SqlExecutor {
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params: readonly SqlValue[] = []) => { await db.runAsync(sql, [...params]); },
    all: <T>(sql: string, params: readonly SqlValue[] = []) => db.getAllAsync<T>(sql, [...params]),
    first: <T>(sql: string, params: readonly SqlValue[] = []) => db.getFirstAsync<T>(sql, [...params]),
  };
}

async function openStore(): Promise<VaultStore> {
  const directory = await DeviceKey.getStorageDirectory();
  const lskHex = await DeviceKey.getOrCreateStorageKey();
  if (!/^[0-9a-f]{64}$/.test(lskHex)) throw new Error('local storage key is malformed');
  const db = await SQLite.openDatabaseAsync(DB_NAME, undefined, directory);
  try {
    // Without SQLCipher linked, PRAGMA key is a silent no-op and the file
    // would be plain SQLite. Refuse instead of writing it unencrypted.
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('this build has no SQLCipher; refusing to open vault.db unencrypted');
    await db.execAsync(`PRAGMA key = "x'${lskHex}'"`);
    // A wrong key surfaces here as "file is not a database", never later.
    await db.getFirstAsync('SELECT count(*) AS n FROM sqlite_master');
    // The credential provider may hold a read lock for a moment.
    await db.execAsync('PRAGMA busy_timeout = 5000');
    return await VaultStore.open(new SerializedSql(executor(db)));
  } catch (err) {
    await db.closeAsync().catch(() => undefined);
    throw err;
  }
}

export const nativePlatform: VaultPlatform = {
  openStore,
  legacy: {
    getItem: (key) => AsyncStorage.getItem(key),
    removeItem: (key) => AsyncStorage.removeItem(key),
  },
  deviceKey: DeviceKey,
};
