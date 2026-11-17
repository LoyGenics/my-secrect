/**
 * DeviceKey JS API — specs/mobile-local-store.md §5. Pure types and
 * helpers (no native import), so Node tests can load them.
 */
export type Biometry = 'faceId' | 'touchId' | 'fingerprint' | 'none';

export type DeviceUnlockScheme = 'ios-se-p256-ecies-v1' | 'ios-kc-aesgcm-v1' | 'android-ks-aesgcm-v1';

/** The only outcomes that cross the native boundary as errors (contract §4). */
export const DEVICE_KEY_ERROR_CODES = [
  'NOT_AVAILABLE', 'NOT_ENROLLED', 'KEY_INVALIDATED', 'USER_CANCEL', 'LOCKOUT', 'AUTH_FAILED', 'CORRUPT',
] as const;
export type DeviceKeyErrorCode = (typeof DEVICE_KEY_ERROR_CODES)[number];

export interface DeviceKeyAvailability {
  available: boolean;
  biometry: Biometry;
  scheme: string | null;
}

export interface DeviceKeyApi {
  isAvailable(): Promise<DeviceKeyAvailability>;
  /** Local Storage Key (SQLCipher raw key) as 64 hex chars. */
  getOrCreateStorageKey(): Promise<string>;
  enroll(amkB64: string, prompt: string): Promise<{ scheme: string; wrappedAmkB64: string }>;
  /** Resolves with the AMK as base64 only after a successful biometric check. */
  unwrap(scheme: string, wrappedAmkB64: string, prompt: string): Promise<string>;
  remove(): Promise<void>;
}

/** Not part of the §5 contract: where vault.db lives (§1) — App Group container on iOS, filesDir on Android. */
export interface DeviceKeyNative extends DeviceKeyApi {
  getStorageDirectory(): Promise<string>;
}

/** The contract code carried by a rejected DeviceKey call, or null for anything else. */
export function deviceKeyErrorCode(err: unknown): DeviceKeyErrorCode | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (DEVICE_KEY_ERROR_CODES as readonly string[]).includes(code)
    ? (code as DeviceKeyErrorCode)
    : null;
}
