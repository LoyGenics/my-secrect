import type { VaultItem } from '../../../packages/core/src/types';

export function isTrashed(item: VaultItem): boolean { return item.deleted_at != null; }

export function passwordStrength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  const label = score <= 2 ? 'Weak' : score <= 4 ? 'Fair' : score === 5 ? 'Strong' : 'Very strong';
  return { score, label };
}

export interface ReusedPasswordGroup { password: string; itemIds: string[]; }
export function findReusedPasswords(items: VaultItem[]): ReusedPasswordGroup[] {
  const byPw = new Map<string, string[]>();
  for (const item of items) {
    if (isTrashed(item) || item.type !== 'login') continue;
    const pw = item.fields?.password;
    if (typeof pw !== 'string' || !pw) continue;
    byPw.set(pw, [...(byPw.get(pw) ?? []), item.id]);
  }
  return [...byPw.entries()].filter(([, ids]) => ids.length > 1).map(([password, itemIds]) => ({ password, itemIds }));
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*+-_=';
const WORDS = ['river', 'meadow', 'harbor', 'lantern', 'cinder', 'willow', 'falcon', 'marble', 'orchard', 'voyage'];

export function generatePassword(opts: { length?: number; symbols?: boolean; numbers?: boolean; uppercase?: boolean; pronounceable?: boolean } = {}): string {
  const { length = 16, symbols = true, numbers = true, uppercase = true, pronounceable = false } = opts;
  if (pronounceable) {
    const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
    return `${w()}-${w()}-${Math.floor(100 + Math.random() * 900)}`;
  }
  let chars = LOWER;
  if (uppercase) chars += UPPER;
  if (numbers) chars += DIGITS;
  if (symbols) chars += SYMBOLS;
  const bytes = new Uint8Array(length);
  // Math.random is NOT cryptographic — the generator output is a convenience
  // for new passwords; the vault itself never relies on it for keys.
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
