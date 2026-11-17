import type { VaultItem } from '../../../packages/core/src/types';
import { passwordStrength, findReusedPasswords, isTrashed, type ReusedPasswordGroup } from './password';

export interface HealthReport {
  total: number; weakCount: number; reusedCount: number;
  reusedGroups: ReusedPasswordGroup[]; weakItems: VaultItem[];
  expiringItems: VaultItem[]; score: number;
}
function expiryDate(item: VaultItem): string | null {
  const f = item.fields as Record<string, unknown>;
  const v = f.expiry_date ?? f.expiry;
  return typeof v === 'string' ? v : null;
}
export function computeHealth(items: VaultItem[]): HealthReport {
  const active = items.filter((i) => !isTrashed(i));
  const weakItems = active.filter((i) => i.type === 'login' && typeof i.fields?.password === 'string' && (i.fields.password as string).length > 0 && passwordStrength(i.fields.password as string).score <= 1);
  const reusedGroups = findReusedPasswords(active);
  const now = Date.now(); const soon = now + 30 * 24 * 3600 * 1000;
  const expiringItems = active.filter((i) => { const d = expiryDate(i); if (!d) return false; const t = Date.parse(d); return !Number.isNaN(t) && t >= now && t <= soon; });
  const score = Math.max(0, Math.min(100, 100 - 15 * weakItems.length - 20 * reusedGroups.length));
  return { total: active.length, weakCount: weakItems.length, reusedCount: reusedGroups.reduce((n, g) => n + g.itemIds.length, 0), reusedGroups, weakItems, expiringItems, score };
}
