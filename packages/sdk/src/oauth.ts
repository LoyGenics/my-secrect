/**
 * Google / Apple sign-in helpers shared by the clients (no network here; the
 * calls are SecurityApiClient.oauthStart / oauthSession).
 *
 * The server verifies the ID token (signature, issuer, audience, expiry,
 * nonce). The client only reads the `email` claim to scope its device key
 * per (server, account), exactly as the email-code path does.
 */

/** Lower-case hex SHA-256 of a UTF-8 string. Apple's `nonce` parameter is
 *  sha256(raw nonce), and its ID token echoes that value back. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `email` claim of a JWT, or '' when it is missing or malformed.
 *  Unverified on purpose: only the server decides whether the token counts. */
export function idTokenEmail(idToken: string): string {
  const payload = idToken.split('.')[1];
  if (!payload) return '';
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')), (c) => c.charCodeAt(0))));
    return typeof json?.email === 'string' ? json.email.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}
