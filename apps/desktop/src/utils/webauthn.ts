/**
 * WebAuthn wire helpers — server JSON <-> browser credential options.
 *
 * The server speaks JSON: challenges, user ids and credential ids are
 * base64url strings. The browser wants ArrayBuffers. These helpers
 * convert in both directions and serialize created / asserted
 * credentials back to the standard WebAuthn JSON shape the server
 * verifies (`{ id, rawId, type, response: {...} }`).
 *
 * No secrets are logged. The credential payloads here contain only
 * public attestation / assertion data — never vault keys or plaintext.
 *
 * Honest limit: if `navigator.credentials` is missing (browser or
 * build without WebAuthn), callers must say so and offer no fake
 * passkey flow. These helpers do not check for that; the components do.
 */

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type LooseRecord = Record<string, any>;

/** Server `creation_options` JSON -> PublicKeyCredentialCreationOptions. */
export function toCreationOptions(options: unknown): PublicKeyCredentialCreationOptions {
  const o = (options ?? {}) as LooseRecord;
  const out: LooseRecord = { ...o };
  if (typeof o.challenge === 'string') out.challenge = base64UrlToBuffer(o.challenge);
  if (o.user && typeof o.user.id === 'string') {
    out.user = { ...o.user, id: base64UrlToBuffer(o.user.id) };
  }
  if (Array.isArray(o.excludeCredentials)) {
    out.excludeCredentials = o.excludeCredentials.map((c: LooseRecord) =>
      typeof c?.id === 'string' ? { ...c, id: base64UrlToBuffer(c.id) } : c,
    );
  }
  return out as PublicKeyCredentialCreationOptions;
}

/** Server `request_options` JSON -> PublicKeyCredentialRequestOptions. */
export function toRequestOptions(options: unknown): PublicKeyCredentialRequestOptions {
  const o = (options ?? {}) as LooseRecord;
  const out: LooseRecord = { ...o };
  if (typeof o.challenge === 'string') out.challenge = base64UrlToBuffer(o.challenge);
  if (Array.isArray(o.allowCredentials)) {
    out.allowCredentials = o.allowCredentials.map((c: LooseRecord) =>
      typeof c?.id === 'string' ? { ...c, id: base64UrlToBuffer(c.id) } : c,
    );
  }
  return out as PublicKeyCredentialRequestOptions;
}

/** A created (registration) credential -> JSON for the server. */
export function serializeCreateCredential(cred: PublicKeyCredential): unknown {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64Url(r.clientDataJSON),
      attestationObject: bufferToBase64Url(r.attestationObject),
      ...(typeof r.getTransports === 'function' ? { transports: r.getTransports() } : {}),
    },
  };
}

/** An asserted (authentication) credential -> JSON for the server. */
export function serializeGetCredential(cred: PublicKeyCredential): unknown {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64Url(r.clientDataJSON),
      authenticatorData: bufferToBase64Url(r.authenticatorData),
      signature: bufferToBase64Url(r.signature),
      ...(r.userHandle ? { userHandle: bufferToBase64Url(r.userHandle) } : {}),
    },
  };
}
