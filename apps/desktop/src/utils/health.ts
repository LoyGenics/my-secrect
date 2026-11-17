/**
 * Vault health report: weak and reused login passwords, overall score.
 * Trashed (deleted) items are excluded from every count.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import {
  passwordStrength,
  findReusedPasswords,
  isTrashed,
  type ReusedPasswordGroup,
} from './password';

export interface HealthReport {
  /** Number of active (non-trashed) items. */
  total: number;
  /** Number of login items whose password scores 0 or 1 (Very weak / Weak). */
  weakCount: number;
  /** Number of login items involved in password reuse (sum of group sizes). */
  reusedCount: number;
  reusedGroups: ReusedPasswordGroup[];
  weakItems: VaultItem[];
  /** 0-100. Starts at 100, -15 per weak item, -20 per reused group. */
  score: number;
}

export function computeHealth(items: VaultItem[]): HealthReport {
  const active = items.filter((item) => !isTrashed(item));
  const weakItems = active.filter((item) => {
    if (item.type !== 'login') return false;
    const pw = item.fields?.password;
    return typeof pw === 'string' && pw.length > 0 && passwordStrength(pw).score <= 1;
  });
  const reusedGroups = findReusedPasswords(active);
  const reusedCount = reusedGroups.reduce((n, g) => n + g.itemIds.length, 0);
  const weakCount = weakItems.length;
  const score = Math.max(0, Math.min(100, 100 - 15 * weakCount - 20 * reusedGroups.length));
  return { total: active.length, weakCount, reusedCount, reusedGroups, weakItems, score };
}
