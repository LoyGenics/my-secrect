/**
 * One-time move of the vault's localStorage keys into the SQLCipher store.
 *
 * Copy -> commit (one transaction) -> verify by reading the database back
 * (not the cache) -> only then delete the localStorage copy. Any failure
 * leaves localStorage untouched, so the next launch simply tries again.
 *
 * The decision and the copy into the backend cache happen synchronously,
 * so the very first render already sees the migrated vault.
 *
 * Never mixes two vaults: if the store already holds vault data that is not
 * byte-identical to localStorage, nothing is copied or deleted ('conflict').
 */
import {
  errorMessage,
  StorageUnavailableError,
  type StorageBackend,
  type TauriSqlcipherBackend,
} from './backend';

export type MigrationReport =
  | { status: 'none' }
  | { status: 'migrated'; keys: string[] }
  | { status: 'conflict'; keys: string[] }
  | { status: 'failed'; error: string }
  | { status: 'cleanup-incomplete'; keys: string[]; error: string };

export function startLegacyMigration(
  legacy: StorageBackend,
  target: TauriSqlcipherBackend,
  keys: readonly string[],
): Promise<MigrationReport> {
  const found = new Map<string, string>();
  try {
    for (const key of keys) {
      const value = legacy.getItem(key);
      if (value !== null) found.set(key, value);
    }
  } catch (err) {
    return Promise.resolve({ status: 'failed', error: `could not read localStorage: ${errorMessage(err)}` });
  }
  if (found.size === 0) return Promise.resolve({ status: 'none' });

  const toCopy: string[] = [];
  let diverged = false;
  let storeOnly = false;
  for (const key of keys) {
    const legacyValue = found.get(key);
    const stored = target.getItem(key);
    if (legacyValue === undefined) {
      if (stored !== null) storeOnly = true;
    } else if (stored === null) {
      toCopy.push(key);
    } else if (stored !== legacyValue) {
      diverged = true;
    }
  }
  // `storeOnly` with nothing to copy = a previous run copied everything but
  // was interrupted while deleting; finishing the cleanup is safe. With
  // something to copy it would splice two different vaults together.
  if (diverged || (storeOnly && toCopy.length > 0)) {
    return Promise.resolve({ status: 'conflict', keys: [...found.keys()] });
  }

  for (const key of toCopy) target.setItem(key, found.get(key)!);

  return target
    .afterPendingWrites(() => target.readCommitted())
    .then(
      (committed): MigrationReport => {
        for (const [key, value] of found) {
          if (committed.entries[key] !== value) {
            const error = new StorageUnavailableError(
              `migration check failed: ${key} read back from the encrypted store does not match localStorage; ` +
                'the localStorage copy was kept',
            );
            target.fail(error);
            return { status: 'failed', error: error.message };
          }
        }
        const leftover: string[] = [];
        let cleanupError = '';
        for (const key of found.keys()) {
          try {
            legacy.removeItem(key);
            if (legacy.getItem(key) !== null) leftover.push(key);
          } catch (err) {
            leftover.push(key);
            cleanupError = errorMessage(err);
          }
        }
        if (leftover.length > 0) {
          return {
            status: 'cleanup-incomplete',
            keys: leftover,
            error: cleanupError || 'localStorage still returns the value after removeItem',
          };
        }
        return { status: 'migrated', keys: [...found.keys()] };
      },
      (err: unknown): MigrationReport => ({ status: 'failed', error: errorMessage(err) }),
    );
}
