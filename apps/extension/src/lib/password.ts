/**
 * Password generator for the background worker. Same sampling as the desktop
 * and mobile generators (apps/desktop/src/utils/password.ts): uniform indexes
 * by rejection sampling, one character of each selected class, shuffled.
 */

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{}';

/**
 * Uniform random index in [0, n): 32-bit draws at or above the largest
 * multiple of n are redrawn, so `% n` has no modulo bias. `fill` is the
 * random source (crypto.getRandomValues); tests pass a fixed sequence.
 */
export function randomIndex(n: number, fill: (buf: Uint32Array) => void = (buf) => { crypto.getRandomValues(buf); }): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error('randomIndex: n must be a positive integer');
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    fill(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function generatePassword(length = 16, symbols = true, numbers = true): string {
  // Phase F fix kept: clamp to 4-64 (4 = one character per class at most).
  length = Math.min(64, Math.max(4, Math.floor(length) || 16));
  let pool = LOWER + UPPER;
  if (numbers) pool += DIGITS;
  if (symbols) pool += SYMBOLS;
  const pick = (chars: string) => chars[randomIndex(chars.length)];
  const chars = [pick(LOWER), pick(UPPER)];
  if (numbers) chars.push(pick(DIGITS));
  if (symbols) chars.push(pick(SYMBOLS));
  while (chars.length < length) chars.push(pick(pool));
  // Fisher-Yates, so no class sits at a fixed position.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
