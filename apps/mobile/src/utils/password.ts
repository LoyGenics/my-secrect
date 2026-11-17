/**
 * Password generation, strength estimation and reuse detection (mobile).
 *
 * SECURITY FIX (Phase E): the previous implementation used Math.random
 * to pick password characters. Math.random is NOT cryptographic — passwords
 * generated that way were predictable. All randomness here now comes from
 * libsodium (`randombytes_buf`, the same CSPRNG the vault keys use).
 *
 * Readiness invariant: libsodium's WASM module is initialised during
 * vault unlock/create (vault.ts awaits `sodiumReady` there), and the
 * generator screens are only reachable after unlock — so sodium is ready
 * whenever this code runs. If it ever is not, generatePassword throws a
 * clear error instead of silently falling back to weak randomness; the
 * callers (GeneratorScreen, ItemFormScreen) catch it and show it.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import { libsodiumAdapter as crypto } from '../../../../packages/crypto-adapters/src/index';

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

/** Uniform random index in [0, n) via rejection sampling (no modulo bias). */
function randomIndex(n: number): number {
  const bytes = crypto.randomBytes(4);
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const limit = Math.floor(0x100000000 / n) * n;
  if (value < limit) return value % n;
  // Extremely rare redraw (~n / 2^32 per draw); loop until in range.
  return randomIndex(n);
}

function pick(chars: string): string {
  return chars[randomIndex(chars.length)];
}

/**
 * Wordlist for passphrase generation (128 words, same list as desktop).
 * 6 words ≈ 42 bits of entropy — the minimum the UI offers for a master
 * passphrase. 4 words (≈ 28 bits) is offered only for low-value uses.
 */
const PASSPHRASE_WORDS = [
  'amber', 'anchor', 'arch', 'atlas', 'autumn', 'baker', 'bamboo', 'banner',
  'barrel', 'basin', 'beacon', 'birch', 'bison', 'blade', 'blaze', 'bloom',
  'bridge', 'bronze', 'brook', 'cabin', 'cactus', 'candle', 'canyon', 'cedar',
  'cherry', 'cinder', 'citrus', 'cliff', 'cloud', 'cobalt', 'comet', 'copper',
  'coral', 'crane', 'creek', 'crown', 'crystal', 'cypress', 'daisy', 'delta',
  'desert', 'dune', 'eagle', 'ember', 'falcon', 'fern', 'fjord', 'flint',
  'forest', 'frost', 'galaxy', 'garden', 'garnet', 'glacier', 'granite', 'grape',
  'grove', 'harbor', 'hazel', 'heather', 'heron', 'horizon', 'hunter', 'indigo',
  'iron', 'island', 'ivory', 'jade', 'juniper', 'kelp', 'lagoon', 'lantern',
  'larch', 'laurel', 'lavender', 'leaf', 'lichen', 'lilac', 'linden', 'lion',
  'lotus', 'lumen', 'lunar', 'magnolia', 'maple', 'marble', 'marsh', 'meadow',
  'melon', 'mercury', 'mesa', 'meteor', 'miller', 'mint', 'mist', 'mosaic',
  'moss', 'mountain', 'nebula', 'nectar', 'oak', 'oasis', 'ocean', 'olive',
  'onyx', 'opal', 'orchard', 'otter', 'oyster', 'pearl', 'pebble', 'pepper',
  'pine', 'plaza', 'prairie', 'quartz', 'raven', 'ridge', 'river', 'robin',
  'rocket', 'rose', 'ruby', 'sage', 'sail', 'salmon', 'sand', 'sapphire',
  'sequoia', 'shell', 'silver', 'sierra', 'solar', 'spruce', 'storm', 'summit',
  'sunset', 'terra', 'thunder', 'timber', 'topaz', 'trail', 'tulip', 'tundra',
  'valley', 'velvet', 'vine', 'violet', 'voyage', 'walnut', 'willow', 'wind',
];

/** Memorable passphrase: N CSPRNG-picked words + a number. */
export function generatePassphrase(words = 6): string {
  try {
    const count = Math.max(3, Math.min(10, Math.floor(words)));
    const picked: string[] = [];
    for (let i = 0; i < count; i++) picked.push(PASSPHRASE_WORDS[randomIndex(PASSPHRASE_WORDS.length)]);
    return `${picked.join('-')}-${10 + randomIndex(90)}`;
  } catch {
    throw new Error('Secure random source is not ready yet — lock and unlock the vault, then try again.');
  }
}

export function generatePassword(opts: { length?: number; symbols?: boolean; numbers?: boolean; uppercase?: boolean; pronounceable?: boolean } = {}): string {
  const { length = 16, symbols = true, numbers = true, uppercase = true, pronounceable = false } = opts;
  try {
    if (pronounceable) {
      const w = () => WORDS[randomIndex(WORDS.length)];
      return `${w()}-${w()}-${100 + randomIndex(900)}`;
    }
    let chars = LOWER;
    if (uppercase) chars += UPPER;
    if (numbers) chars += DIGITS;
    if (symbols) chars += SYMBOLS;
    const out: string[] = [];
    for (let i = 0; i < length; i++) out.push(pick(chars));
    return out.join('');
  } catch {
    throw new Error('Secure random source is not ready yet — lock and unlock the vault, then try again.');
  }
}
