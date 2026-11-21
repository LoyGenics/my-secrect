/**
 * Account sign-in gate (pure, testable). Every user signs in to an account
 * before creating or unlocking a vault: there is no local-only mode. Order:
 *   1. no account server known -> 'connect-server' (URL field, blocking);
 *   2. no valid session        -> 'sign-in';
 *   3. signed in               -> 'vault' (onboarding or lock screen).
 */
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
 *  only for this machine (local development). */
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
