/**
 * Password generation, strength estimation and reuse detection.
 * All randomness comes from crypto.getRandomValues (CSPRNG).
 */
import type { VaultItem } from '../../../../packages/core/src/types';

/**
 * favorite / deleted_at are part of the VaultItem contract in the task spec
 * but are not yet declared in packages/core/src/types.ts on disk; access them
 * through this alias so this code keeps working once the type gains them.
 */
export type VaultItemMeta = VaultItem & {
  favorite?: boolean;
  deleted_at?: string | null;
};

export function isTrashed(item: VaultItem): boolean {
  return Boolean((item as VaultItemMeta).deleted_at);
}

export function isFavorite(item: VaultItem): boolean {
  return Boolean((item as VaultItemMeta).favorite);
}

export interface GeneratePasswordOptions {
  length: number;
  symbols: boolean;
  numbers: boolean;
  uppercase: boolean;
  lowercase: boolean;
  pronounceable?: boolean;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?/~';
const CONSONANTS = 'bcdfghjklmnpqrstvwxz';
const VOWELS = 'aeiou';

/** Uniform random index in [0, n) via rejection sampling (no modulo bias). */
function randomIndex(n: number): number {
  if (n <= 0) throw new Error('randomIndex: n must be positive');
  const buf = new Uint32Array(1);
  // Largest multiple of n that fits in 32 bits; values >= limit are redrawn.
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function pick(chars: string): string {
  return chars[randomIndex(chars.length)];
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function generatePassword(opts: GeneratePasswordOptions): string {
  const length = Math.max(1, Math.floor(opts.length));

  if (opts.pronounceable) {
    // Pronounceable mode: alternating consonant/vowel syllables plus digits.
    // Symbols are ignored here by design — a pronounceable password has none.
    const digitCount = opts.numbers ? Math.max(1, Math.floor(length / 5)) : 0;
    const lettersLength = Math.max(2, length - digitCount);
    let letters = '';
    while (letters.length < lettersLength) {
      let syllable = pick(CONSONANTS) + pick(VOWELS);
      if (randomIndex(2) === 0) syllable += pick(CONSONANTS);
      letters += syllable;
    }
    letters = letters.slice(0, lettersLength);
    if (opts.uppercase) {
      letters = letters.charAt(0).toUpperCase() + letters.slice(1);
    }
    const chars = letters.split('');
    for (let i = 0; i < digitCount; i++) {
      chars.splice(randomIndex(chars.length + 1), 0, pick(DIGITS));
    }
    return chars.join('');
  }

  let pool = '';
  const required: string[] = [];
  if (opts.lowercase) {
    pool += LOWER;
    required.push(pick(LOWER));
  }
  if (opts.uppercase) {
    pool += UPPER;
    required.push(pick(UPPER));
  }
  if (opts.numbers) {
    pool += DIGITS;
    required.push(pick(DIGITS));
  }
  if (opts.symbols) {
    pool += SYMBOLS;
    required.push(pick(SYMBOLS));
  }
  if (pool.length === 0) {
    pool = LOWER;
    required.push(pick(LOWER));
  }
  const chars = [...required];
  while (chars.length < length) chars.push(pick(pool));
  return shuffle(chars).slice(0, length).join('');
}

/**
 * Wordlist for passphrase generation. A short built-in list (128 words)
 * keeps the bundle dependency-free; each word is picked with the CSPRNG
 * above, so a 4-word passphrase has ~28 bits of entropy per word
 * (log2(128) = 7) — 4 words ≈ 28 bits is NOT enough for a master
 * passphrase on its own. Use 6+ words for anything that protects the
 * vault itself; the UI defaults to 6 and says so.
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

export interface PassphraseOptions {
  words?: number; // default 6
  separator?: string; // default '-'
  includeNumber?: boolean; // append a 2-4 digit number, default true
}

/** Memorable passphrase: N random words + an optional number, CSPRNG-picked. */
export function generatePassphrase(opts: PassphraseOptions = {}): string {
  const count = Math.max(3, Math.min(10, Math.floor(opts.words ?? 6)));
  const sep = opts.separator ?? '-';
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(PASSPHRASE_WORDS[randomIndex(PASSPHRASE_WORDS.length)]);
  let out = words.join(sep);
  if (opts.includeNumber !== false) out += sep + String(10 + randomIndex(90));
  return out;
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  feedback: string[];
  crackTime: string;
}

const COMMON_PASSWORDS = [
  '123456', 'password', '123456789', '12345678', '12345', '1234567',
  '1234567890', 'qwerty', 'abc123', '111111', '123123', 'admin',
  'letmein', 'welcome', 'monkey', 'dragon', 'master', 'sunshine',
  'princess', 'football', 'iloveyou', '1234', 'password1', 'qwerty123',
  '000000', '1qaz2wsx', '654321', 'charlie', 'aa123456', 'donald',
];

const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

function formatCrackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return 'instant';
  if (seconds < 60) return 'a few seconds';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  const months = days / 30;
  if (months < 12) return `${Math.round(months)} month${Math.round(months) === 1 ? '' : 's'}`;
  const years = months / 12;
  if (years < 100) return `${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'}`;
  if (years < 1000) return 'centuries';
  return 'millennia';
}

export function passwordStrength(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: STRENGTH_LABELS[0], feedback: ['Enter a password'], crackTime: 'instant' };
  }
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) {
    return {
      score: 0,
      label: STRENGTH_LABELS[0],
      feedback: ['This is a commonly used password — choose something unique'],
      crackTime: 'instant',
    };
  }
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const variety = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  const feedback: string[] = [];
  let score = 0;
  if (password.length >= 8) {
    score += 1;
  } else {
    feedback.push('Use at least 8 characters');
  }
  if (password.length >= 12) score += 1;
  if (variety >= 3) {
    score += 1;
  } else {
    feedback.push('Mix uppercase, lowercase, numbers and symbols');
  }
  if ((password.length >= 16 && variety >= 3) || password.length >= 20) score += 1;
  if (password.length < 12) feedback.push('A longer password (12+ characters) is much stronger');
  if (/^(.)\1+$/.test(password)) feedback.push('Avoid repeating the same character');
  const clamped = Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;

  // Rough offline-cracking estimate: 10 billion guesses/second.
  let charsetSize = 0;
  if (hasLower) charsetSize += 26;
  if (hasUpper) charsetSize += 26;
  if (hasDigit) charsetSize += 10;
  if (hasSymbol) charsetSize += 32;
  const guesses = Math.pow(charsetSize || 1, password.length);
  const crackTime = formatCrackTime(guesses / 2 / 1e10);

  return { score: clamped, label: STRENGTH_LABELS[clamped], feedback, crackTime };
}

export interface ReusedPasswordGroup {
  password: string;
  itemIds: string[];
}

/**
 * Group login items sharing the same password. Only groups with 2+ items
 * are returned. Trashed (deleted) items are excluded.
 */
export function findReusedPasswords(items: VaultItem[]): ReusedPasswordGroup[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    if (item.type !== 'login' || isTrashed(item)) continue;
    const pw = item.fields?.password;
    if (typeof pw !== 'string' || pw.length === 0) continue;
    const ids = groups.get(pw) ?? [];
    ids.push(item.id);
    groups.set(pw, ids);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([password, itemIds]) => ({ password, itemIds }));
}
