/**
 * RFC 6238 TOTP (time-based one-time password).
 * 30-second period, 6 digits, HMAC-SHA1 via WebCrypto (crypto.subtle).
 *
 * NOTE: crypto.subtle is async-only, so generateTotp is async and returns a
 * Promise. A synchronous signature is impossible with WebCrypto HMAC-SHA1.
 * Callers await it (e.g. inside useEffect / setInterval).
 *
 * An invalid secret resolves to an empty code (''); callers show
 * 'Invalid TOTP secret' in that case.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpResult {
  code: string;
  secondsRemaining: number;
  period: number;
}

/** Decode a base32 string (RFC 4648, A-Z2-7, case-insensitive, spaces ignored). */
export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(cleaned)) {
    throw new Error('Invalid base32 character');
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  // Any leftover bits must be zero padding bits.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('Invalid base32 padding');
  }
  return new Uint8Array(bytes);
}

export function isValidBase32Secret(secret: string): boolean {
  if (typeof secret !== 'string') return false;
  const cleaned = secret.replace(/[\s=]/g, '').toUpperCase();
  if (cleaned.length < 8) return false;
  if (!/^[A-Z2-7]+$/.test(cleaned)) return false;
  try {
    const decoded = decodeBase32(cleaned);
    return decoded.length >= 8;
  } catch {
    return false;
  }
}

export async function generateTotp(secret: string, now: number = Date.now()): Promise<TotpResult> {
  const period = TOTP_PERIOD_SECONDS;
  const secondsRemaining = period - (Math.floor(now / 1000) % period);
  if (!isValidBase32Secret(secret)) {
    return { code: '', secondsRemaining, period };
  }
  const keyBytes = decodeBase32(secret);
  const counter = Math.floor(now / 1000 / period);
  const counterBytes = new Uint8Array(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, counterBytes);
  const h = new Uint8Array(signature);
  const offset = h[h.length - 1] & 0x0f;
  const binary =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  const code = (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
  return { code, secondsRemaining, period };
}
