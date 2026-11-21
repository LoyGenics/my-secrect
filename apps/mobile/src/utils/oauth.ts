/**
 * Google / Apple account sign-in: the API calls and the pure rules around
 * them. No React Native imports, so tests run it in Node.
 *
 *   GET  /v1/auth/providers                -> which buttons to show (client IDs)
 *   POST /v1/auth/oauth/start              -> { ticket, nonce, expires_at }
 *   IdP sign-in with the nonce             -> ID token
 *   POST /v1/auth/oauth/:provider/session  -> same JSON as /v1/auth/email/session
 *
 * Google gets the raw nonce; Apple gets its SHA-256 hex (Apple puts the value
 * it was given in the token, and the server compares it with sha256(raw)).
 * No `device` proof is sent: the mobile app does not enrol or bind devices
 * until a keystore-backed device key exists (specs/device-identity.md §8.3),
 * the same as its email-code sign-in.
 */
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { ApiError, type SignInResult } from '../../../../packages/sdk/src/security';

export type OAuthProvider = 'google' | 'apple';

export interface AuthProviders {
  google: { web_client_id?: string; ios_client_id?: string; android_client_id?: string; extension_client_id?: string } | null;
  apple: { services_id?: string; bundle_id?: string } | null;
}

export interface OAuthStart { ticket: string; nonce: string; expires_at: string }

export interface OAuthSessionBody { ticket: string; id_token: string; full_name?: string }

/** Must match app.json `android.package`, which is also registered there as a URL scheme. */
export const ANDROID_PACKAGE = 'com.loygenics.mysecrect';

export const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

/**
 * A button appears only when the server can verify that platform's token:
 * Apple on iOS with the bundle ID configured (native tokens carry it as `aud`),
 * Google with this platform's client ID.
 */
export function providerButtons(providers: AuthProviders | null, os: string, appleAvailable: boolean) {
  const google = providers?.google;
  const clientId = ({ ios: google?.ios_client_id, android: google?.android_client_id } as Record<string, unknown>)[os];
  return {
    apple: os === 'ios' && appleAvailable && Boolean(providers?.apple?.bundle_id),
    googleClientId: typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null,
  };
}

/** iOS: Google's reversed client ID scheme. Android: the package name scheme. */
export function googleRedirectUri(os: string, clientId: string): string {
  if (os === 'ios') return `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}:/oauthredirect`;
  return `${ANDROID_PACKAGE}:/oauthredirect`;
}

/** The value Apple receives as `nonce`. */
export function appleNonce(rawNonce: string): string {
  return bytesToHex(sha256(utf8ToBytes(rawNonce)));
}

/** Apple sends the name on the first sign-in only. */
export function appleFullName(name: { givenName?: string | null; middleName?: string | null; familyName?: string | null } | null | undefined) {
  const joined = [name?.givenName, name?.middleName, name?.familyName].map(part => part?.trim()).filter(Boolean).join(' ');
  return joined || undefined;
}

export function oauthSessionBody(ticket: string, idToken: string, fullName?: string): OAuthSessionBody {
  return { ticket, id_token: idToken, ...(fullName ? { full_name: fullName } : {}) };
}

/** The account email shown after sign-in. Display only: the server verifies the token. */
export function idTokenEmail(idToken: string): string {
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64').toString('utf8')) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

async function request<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + path, body === undefined
    ? { headers: { Accept: 'application/json' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, path, await res.json().catch(() => undefined));
  return res.json() as Promise<T>;
}

export function fetchAuthProviders(baseUrl: string): Promise<AuthProviders> {
  return request<AuthProviders>(baseUrl, '/v1/auth/providers');
}

export function startOAuth(baseUrl: string): Promise<OAuthStart> {
  return request<OAuthStart>(baseUrl, '/v1/auth/oauth/start', {});
}

export function oauthSession(baseUrl: string, provider: OAuthProvider, body: OAuthSessionBody): Promise<SignInResult> {
  return request<SignInResult>(baseUrl, `/v1/auth/oauth/${provider}/session`, body);
}
