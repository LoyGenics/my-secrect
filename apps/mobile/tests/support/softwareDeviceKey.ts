/**
 * Stand-in for the native DeviceKey module so vault.ts's handling of
 * every DeviceKey outcome can run in Node. It is NOT the module under
 * test: the Swift / Kotlin code is exercised only on the simulator /
 * emulator. The wrap is real (XChaCha20-Poly1305 under a random key held
 * in memory), so a wrong or tampered blob really fails to open.
 */
import {
  libsodiumAdapter as crypto, sodiumReady, toBase64, fromBase64,
} from '../../../../packages/crypto-adapters/src/index';
import type { DeviceKeyApi, DeviceKeyErrorCode } from '../../modules/device-key/src/DeviceKey.types';

export const SOFTWARE_SCHEME = 'test-software-v1';

function coded(code: DeviceKeyErrorCode): Error { return Object.assign(new Error(code), { code }); }

export class SoftwareDeviceKey implements DeviceKeyApi {
  private key: Uint8Array | null = null;
  /** Next enroll/unwrap rejects with this code (like a cancelled or failed prompt). */
  nextError: DeviceKeyErrorCode | null = null;
  /** Biometric set changed: the key can no longer be used. */
  invalidated = false;
  /** Resolve unwrap with this instead of the real AMK (a damaged native result). */
  forceAmkB64: string | null = null;
  removeCalls = 0;
  prompts: string[] = [];

  async isAvailable() { return { available: true, biometry: 'faceId' as const, scheme: SOFTWARE_SCHEME }; }
  async getOrCreateStorageKey() { return 'ab'.repeat(32); }

  async enroll(amkB64: string, prompt: string) {
    this.prompts.push(prompt);
    if (this.nextError) { const c = this.nextError; this.nextError = null; throw coded(c); }
    await sodiumReady;
    this.key = crypto.randomBytes(32);
    this.invalidated = false;
    const { nonce, ciphertext } = await crypto.encrypt(this.key, fromBase64(amkB64));
    const blob = new Uint8Array(nonce.length + ciphertext.length);
    blob.set(nonce, 0); blob.set(ciphertext, nonce.length);
    return { scheme: SOFTWARE_SCHEME, wrappedAmkB64: toBase64(blob) };
  }

  async unwrap(scheme: string, wrappedAmkB64: string, prompt: string) {
    this.prompts.push(prompt);
    if (this.nextError) { const c = this.nextError; this.nextError = null; throw coded(c); }
    if (!this.key || this.invalidated) throw coded('KEY_INVALIDATED');
    if (scheme !== SOFTWARE_SCHEME) throw coded('CORRUPT');
    if (this.forceAmkB64 !== null) return this.forceAmkB64;
    const blob = fromBase64(wrappedAmkB64);
    try { return toBase64(await crypto.decrypt(this.key, blob.subarray(0, 24), blob.subarray(24))); }
    catch { throw coded('CORRUPT'); }
  }

  async remove() { this.removeCalls += 1; this.key = null; }
}
