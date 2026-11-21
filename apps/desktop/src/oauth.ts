/**
 * "Continue with Google" / "Continue with Apple" — getting an ID token from
 * the identity provider. The API call around it (POST auth/oauth/start, then
 * POST auth/oauth/:provider/session) lives in SignInScreen.
 *
 * Web: Google Identity Services (Google's own button, popup) and Sign in
 * with Apple JS (popup). Both scripts load only on the sign-in screen.
 *
 * Desktop (Tauri): Google refuses OAuth in embedded webviews, so the Rust
 * command `google_sign_in` runs Authorization Code + PKCE in the system
 * browser with a loopback redirect (src-tauri/src/google_oauth.rs). It needs
 * a Google "Desktop app" OAuth client: VITE_GOOGLE_DESKTOP_CLIENT_ID (and
 * that client's non-confidential secret, VITE_GOOGLE_DESKTOP_CLIENT_SECRET,
 * which Google still requires for that client type). Apple is hidden on
 * desktop: Apple's web flow only redirects to a registered https URL, so a
 * loopback redirect is impossible.
 */
import { invoke } from '@tauri-apps/api/core';
import type { AuthProvidersResponse, OAuthProvider } from '../../../packages/sdk/src/security';

export const GOOGLE_GSI_SRC = 'https://accounts.google.com/gsi/client';
export const APPLE_JS_SRC = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

/** The user closed the provider's window or declined. Not an error to show. */
export class OAuthCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'OAuthCancelled';
  }
}

/** Which provider buttons this platform shows for the server's answer. */
export function visibleProviders(
  providers: AuthProvidersResponse | null,
  platform: 'web' | 'desktop',
  desktopGoogleClientId: string,
): OAuthProvider[] {
  if (!providers) return [];
  if (platform === 'desktop') return providers.google && desktopGoogleClientId ? ['google'] : [];
  const out: OAuthProvider[] = [];
  if (providers.google?.web_client_id) out.push('google');
  if (providers.apple?.services_id) out.push('apple');
  return out;
}

const loading = new Map<string, Promise<void>>();

/** Adds a provider script once; resolves when it has loaded. */
export function loadScript(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(src);
        el.remove();
        reject(new Error(`could not load ${src}`));
      };
      document.head.appendChild(el);
    });
    loading.set(src, p);
  }
  return p;
}

/* Minimal shapes of the two provider SDKs (only what is used here). */
interface GoogleId {
  initialize(cfg: {
    client_id: string;
    nonce: string;
    callback: (res: { credential?: string }) => void;
    ux_mode: 'popup';
    auto_select: boolean;
    itp_support: boolean;
  }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
interface AppleAuth {
  init(cfg: { clientId: string; scope: string; redirectURI: string; nonce: string; state: string; usePopup: boolean }): void;
  signIn(): Promise<{
    authorization?: { id_token?: string };
    user?: { name?: { firstName?: string; lastName?: string } };
  }>;
}
type ProviderWindow = Window & { google?: { accounts?: { id?: GoogleId } }; AppleID?: { auth?: AppleAuth } };

/** Renders Google's button into `el`. A click opens Google's popup; the ID
 *  token (bound to `nonce`) arrives in `onIdToken`. */
export function renderGoogleButton(el: HTMLElement, clientId: string, nonce: string, locale: string, onIdToken: (idToken: string) => void): void {
  const gid = (window as ProviderWindow).google?.accounts?.id;
  if (!gid) throw new Error('Google Identity Services did not load');
  gid.initialize({
    client_id: clientId,
    nonce,
    callback: (res) => { if (res.credential) onIdToken(res.credential); },
    ux_mode: 'popup',
    auto_select: false,
    itp_support: true,
  });
  el.replaceChildren();
  gid.renderButton(el, {
    type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill',
    logo_alignment: 'center', width: Math.min(400, Math.max(200, Math.round(el.clientWidth || 320))), locale,
  });
}

/** Apple's popup. `hashedNonce` = SHA-256 hex of the API's raw nonce. Must
 *  run straight from the click (no await before it) or the popup is blocked. */
export async function appleSignIn(servicesId: string, hashedNonce: string): Promise<{ idToken: string; fullName?: string }> {
  const auth = (window as ProviderWindow).AppleID?.auth;
  if (!auth) throw new Error('Sign in with Apple did not load');
  auth.init({
    clientId: servicesId,
    scope: 'name email',
    redirectURI: `${window.location.origin}/`,
    nonce: hashedNonce,
    state: crypto.randomUUID(),
    usePopup: true,
  });
  let res: Awaited<ReturnType<AppleAuth['signIn']>>;
  try {
    res = await auth.signIn();
  } catch (err) {
    const code = (err as { error?: unknown })?.error;
    if (code === 'popup_closed_by_user' || code === 'user_cancelled_authorize') throw new OAuthCancelled();
    throw err;
  }
  const idToken = res.authorization?.id_token;
  if (!idToken) throw new Error('Apple returned no ID token');
  // Apple sends the name on the FIRST authorization only.
  const name = [res.user?.name?.firstName, res.user?.name?.lastName].filter(Boolean).join(' ').trim();
  return { idToken, ...(name ? { fullName: name } : {}) };
}

/** Desktop: the system-browser round trip in Rust. */
export async function desktopGoogleSignIn(clientId: string, clientSecret: string, nonce: string): Promise<string> {
  try {
    return await invoke<string>('google_sign_in', { clientId, clientSecret: clientSecret || null, nonce });
  } catch (err) {
    if (err === 'cancelled') throw new OAuthCancelled();
    throw new Error(String(err));
  }
}
