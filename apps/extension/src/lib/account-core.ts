/**
 * Account sign-in rules for the extension, pure (no chrome.*, no fetch):
 * API base URL validation, the Google authorize URL, the redirect parsing
 * and the error mapping. The background (lib/account.ts) does the I/O.
 * Unit-tested in tests/account-core.test.ts.
 */

/** Errors the popup/options can show. Never carries server detail. */
export type AuthErrorCode =
  | 'signed-out'
  | 'server-not-configured'
  | 'invalid-server-url'
  | 'invalid-email'
  | 'email-unavailable'
  | 'code-failed'
  | 'code-expired'
  | 'mfa-failed'
  | 'verification-failed'
  | 'device-rejected'
  | 'provider-unavailable'
  | 'cancelled'
  | 'offline'
  | 'unknown';

/**
 * '' (use the build default) or an https URL. Plain http only for a local
 * development server on this machine: the session token is a Bearer
 * credential and never crosses the network in clear text. Returns the URL
 * without a trailing slash, or null when it is not acceptable.
 */
export function normalizeApiBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Google OIDC implicit flow for chrome.identity.launchWebAuthFlow: the id
 * token comes back in the redirect fragment. `nonce` is the RAW nonce from
 * POST /v1/auth/oauth/start (Google echoes it in the token; the server
 * compares). `state` is a fresh random value checked on the way back.
 */
export function googleAuthUrl(p: { clientId: string; redirectUri: string; nonce: string; state: string }): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('response_type', 'id_token');
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('state', p.state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** The id_token from the redirect URL, or null (cancelled, error, wrong redirect or state). */
export function idTokenFromRedirect(responseUrl: string | undefined, redirectUri: string, state: string): string | null {
  if (!responseUrl || !responseUrl.startsWith(redirectUri)) return null;
  const hash = responseUrl.split('#', 2)[1] ?? '';
  const params = new URLSearchParams(hash);
  if (params.get('state') !== state) return null;
  const token = params.get('id_token');
  return token && token.split('.').length === 3 ? token : null;
}

/**
 * The account email (or subject) a JWT names, read WITHOUT verifying it.
 * Used only to pick the local device-key record; the server verifies the
 * token itself and decides the account.
 */
export function unverifiedJwtAccount(idToken: string): string | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4));
    const claims = JSON.parse(json) as Record<string, unknown>;
    if (typeof claims.email === 'string' && claims.email) return claims.email.trim().toLowerCase();
    if (typeof claims.sub === 'string' && claims.sub) return `sub:${claims.sub}`;
  } catch {
    return null;
  }
  return null;
}

/** A non-2xx API answer, or a fetch that never reached the server (status 0). */
export interface ApiFailure {
  status: number;
  error: string;
}

export function isApiFailure(e: unknown): e is ApiFailure {
  return typeof e === 'object' && e !== null && typeof (e as ApiFailure).status === 'number' && typeof (e as ApiFailure).error === 'string';
}

/**
 * Map a failure to what the user can act on. The server answers one
 * generic 401 for every verification problem, so this never claims more.
 */
export function authErrorFor(e: unknown, step: 'request' | 'code' | 'session' | 'mfa' | 'oauth'): AuthErrorCode {
  if (!isApiFailure(e)) return 'unknown';
  if (e.status === 0) return 'offline';
  if (e.status === 401 && e.error === 'device_verification_failed') return 'device-rejected';
  if (step === 'request') {
    if (e.status === 422) return 'invalid-email';
    if (e.status === 503) return 'email-unavailable';
  }
  if (e.status === 401) {
    if (step === 'code') return 'code-failed';
    if (step === 'session') return 'code-expired';
    if (step === 'mfa') return 'mfa-failed';
    return 'verification-failed';
  }
  return 'unknown';
}
