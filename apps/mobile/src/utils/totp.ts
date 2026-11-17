/**
 * RFC 6238 TOTP, PURE TypeScript (synchronous) — written for React Native.
 * The desktop version uses WebCrypto HMAC-SHA1, which is async-only and
 * not available in Hermes. This version implements SHA-1 + HMAC-SHA-1
 * directly, so `generateTotp` is synchronous and can run in a 1s interval.
 * 30-second period, 6 digits. Invalid secret -> code ''.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(cleaned)) throw new Error('Invalid base32 character');
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const ch of cleaned) {
    value = (value << 5) | BASE32.indexOf(ch); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw new Error('Invalid base32 padding');
  return new Uint8Array(bytes);
}

export function isValidBase32Secret(secret: string): boolean {
  if (typeof secret !== 'string') return false;
  const c = secret.replace(/[\s=]/g, '').toUpperCase();
  if (c.length < 8 || !/^[A-Z2-7]+$/.test(c)) return false;
  try { return decodeBase32(c).length >= 8; } catch { return false; }
}

function rotr(x: number, n: number): number { return ((x >>> n) | (x << (32 - n))) >>> 0; }
function sha1(msg: Uint8Array): Uint8Array {
  let h0 = 0x67452301; let h1 = 0xefcdab89; let h2 = 0x98badcfe; let h3 = 0x10325476; let h4 = 0xc3d2e1f0;
  const ml = msg.length; const bitLen = ml * 8;
  const paddedLen = (((ml + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(paddedLen); buf.set(msg); buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 4, bitLen & 0xffffffff); dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  const w = new Uint32Array(80);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotr(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number; let k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotr(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotr(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20); const o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => o.setUint32(i * 4, h));
  return out;
}
function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  const k = key.length > 64 ? sha1(key) : key;
  block.set(k);
  const ipad = new Uint8Array(64); const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }
  const inner = new Uint8Array(64 + msg.length); inner.set(ipad); inner.set(msg, 64);
  const outer = new Uint8Array(64 + 20); outer.set(opad); outer.set(sha1(inner), 64);
  return sha1(outer);
}

export interface TotpResult { code: string; secondsRemaining: number; period: number; }
export function generateTotp(secret: string, now: number = Date.now()): TotpResult {
  const period = TOTP_PERIOD_SECONDS;
  const secondsRemaining = period - (Math.floor(now / 1000) % period);
  if (!isValidBase32Secret(secret)) return { code: '', secondsRemaining, period };
  const keyBytes = decodeBase32(secret);
  const counter = Math.floor(now / 1000 / period);
  const counterBytes = new Uint8Array(8);
  let rem = counter;
  for (let i = 7; i >= 0; i--) { counterBytes[i] = rem & 0xff; rem = Math.floor(rem / 256); }
  const h = hmacSha1(keyBytes, counterBytes);
  const offset = h[h.length - 1] & 0x0f;
  const binary = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
  return { code: (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0'), secondsRemaining, period };
}
