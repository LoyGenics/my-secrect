/**
 * Account sign-in gate (pure, testable). Every user signs in to an account
 * before creating or unlocking a vault: there is no local-only mode. Order:
 *   1. no account server known -> 'connect-server' (URL field, blocking);
 *   2. no valid session        -> 'sign-in';
 *   3. signed in               -> 'vault' (onboarding or lock screen).
 */
import {
  LS_API_TOKEN_EXPIRES_AT,
  clearSessionToken,
  getValidTokenSync,
  isUnauthorized,
  type SyncTokenStore,
} from '../../../packages/sdk/src/security';

export type AuthGateStep = 'connect-server' | 'sign-in' | 'vault';

export function authGateStep(apiBaseUrl: string, signedIn: boolean): AuthGateStep {
  if (!apiBaseUrl.trim()) return 'connect-server';
  return signedIn ? 'vault' : 'sign-in';
}

/** The account server to use: the one saved on this device, else the
 *  build's default (web: same origin; desktop: VITE_MY_SECRET_API_BASE_URL).
 *  An empty saved value no longer means "local-only": it falls back. */
export function resolveApiBaseUrl(saved: string | null, buildDefault: string): string {
  return saved?.trim() || buildDefault.trim();
}

/** A URL the user may enter as the account server: https, or plain http
 *  only for this machine (local development). Because the server is chosen
 *  at run time, the desktop CSP (src-tauri/tauri.conf.json, JSON: no
 *  comments there) must allow `connect-src https:` plus local http; only
 *  connect-src is opened that way (specs/account-sign-in.md). */
export function isAcceptableApiBaseUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export type StoredSession = 'signed-in' | 'signed-out' | 'revoked';

/**
 * May the stored session token open the vault? A stored token is never
 * trusted on its own (same policy as mobile): it is checked with the server
 * (`checkSession`, any authenticated call).
 *   - server answers           -> 'signed-in'
 *   - server answers 401       -> token cleared, 'revoked' (back to sign-in)
 *   - server unreachable       -> 'signed-in' only when the token has a
 *     known, unexpired expiry (offline, local-first); without a stored
 *     expiry it stays 'signed-out' until it can be verified online.
 * No token, or one past its stored expiry, is 'signed-out' without a call.
 */
export async function verifyStoredSession(store: SyncTokenStore, checkSession: () => Promise<unknown>): Promise<StoredSession> {
  if (!getValidTokenSync(store)) return 'signed-out';
  try {
    await checkSession();
    return 'signed-in';
  } catch (err) {
    if (isUnauthorized(err)) {
      await clearSessionToken(store);
      return 'revoked';
    }
    return /^\d+$/.test(store.getItem(LS_API_TOKEN_EXPIRES_AT) ?? '') ? 'signed-in' : 'signed-out';
  }
}
