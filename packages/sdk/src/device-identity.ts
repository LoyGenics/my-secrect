/**
 * @my-secrect/sdk — device identity v1, message format (pure: no I/O, no
 * DOM, no crypto). specs/device-identity.md is normative; the server
 * counterpart is apps/api/app/domains/authentication/device_proof.rb.
 *
 *   message = "my-secrect/device/v1/" || purpose || "\n" || canonical_json(payload)
 *
 * canonical_json: one flat object, keys [a-z_]+ sorted by byte value,
 * string values of printable ASCII without '"' and '\', no whitespace.
 * Anything else throws instead of being escaped, so every implementation
 * produces the same bytes. The signature is plain Ed25519 over `message`.
 *
 * Purposes (v1 registry): 'enroll', 'session-bind'. 'sync-event' is
 * reserved for the sync protocol and must be specified there first.
 */

export const DEVICE_MESSAGE_DOMAIN = 'my-secrect/device/v1/';

export type DevicePurpose = 'enroll' | 'session-bind';

const PURPOSE_FORMAT = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_FORMAT = /^[a-z_]+$/;
// Printable ASCII minus '"' (0x22) and '\' (0x5C).
const VALUE_FORMAT = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

export function canonicalPayload(payload: Record<string, string>): string {
  const keys = Object.keys(payload).sort();
  const members = keys.map((key) => {
    const value = payload[key];
    if (!KEY_FORMAT.test(key)) throw new Error(`device payload: invalid key ${JSON.stringify(key)}`);
    if (typeof value !== 'string' || !VALUE_FORMAT.test(value)) {
      throw new Error(`device payload: value for ${key} is not a plain ASCII string`);
    }
    return `"${key}":"${value}"`;
  });
  return `{${members.join(',')}}`;
}

/** The exact bytes a device key signs for `purpose` + `payload`. */
export function deviceMessage(purpose: string, payload: Record<string, string>): Uint8Array {
  if (!PURPOSE_FORMAT.test(purpose)) throw new Error('device message: invalid purpose');
  return new TextEncoder().encode(`${DEVICE_MESSAGE_DOMAIN}${purpose}\n${canonicalPayload(payload)}`);
}

/** Payload for enrolling `publicKeyB64Url` (32-byte key, base64url, no padding). */
export function enrollPayload(challenge: string, publicKeyB64Url: string): Record<string, string> {
  return { challenge, public_key: publicKeyB64Url };
}

/** Payload for binding a session to device `deviceId`. */
export function sessionBindPayload(challenge: string, deviceId: string): Record<string, string> {
  return { challenge, device_id: deviceId };
}

/** Base64url without padding (the only encoding the signed payload uses). */
export function toBase64UrlNoPad(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `device` field of POST /v1/auth/passkeys/verify (spec §6.1). */
export type SignInDeviceProof =
  | { public_key: string; signature: string; platform?: string }
  | { id: string; signature: string };
