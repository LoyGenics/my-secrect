/**
 * Account sign-in — background service worker ONLY. The popup and options
 * page never import this file: they send the narrow account messages in
 * lib/messages.ts and get back an AccountStatus, never the session token.
 *
 * Owner rule: an account sign-in comes before creating, unlocking or
 * restoring a vault (background.ts refuses those unless
 * verifySessionForVault() is true). Sign-in is account auth only; the vault passphrase stays a
 * separate, later step and never leaves this worker.
 *
 * Storage:
 *  - The session token, its expiry, the account email and any pending
 *    sign-in step (email being verified, single-use MFA token) live in
 *    chrome.storage.session: memory-only (gone when the browser quits),
 *    survives a worker restart, and is not exposed to content scripts
 *    (TRUSTED_CONTEXTS, the default; the hardening e2e checks it).
 *  - That area is still writable by any extension page, so a record there
 *    is NOT proof of sign-in. Before a vault is created, unlocked or
 *    restored, verifySessionForVault() asks the server (GET
 *    /v1/auth/sessions) unless THIS worker verified or received the same
 *    token in the last VERIFY_WINDOW_MS. Offline, only a token this worker
 *    lifetime has itself verified or received is accepted; after a worker
 *    restart an offline unlock fails closed.
 *  - Whenever the session ends (sign-out, 401, local expiry, server change)
 *    the signed-out handler runs: background.ts locks the vault, drops the
 *    save offer and the auto-lock alarm.
 *  - The API base URL override (not a secret) lives in chrome.storage.local.
 *  - The Ed25519 device key lives in this extension's IndexedDB through the
 *    SDK device-key store (non-extractable WebCrypto key when available),
 *    exactly as on desktop/web; it signs the email ticket or OAuth nonce.
 */
import { HOSTED_API_BASE_URL } from '../../../../packages/sdk/src/hosted';
import {
  deviceKeyScope,
  prepareSignInDeviceProof,
  type PreparedDeviceProof,
} from '../../../../packages/sdk/src/device-key-store';
import type { SignInDeviceProof } from '../../../../packages/sdk/src/device-identity';
import { isValidEmail, normalizeEmail } from '../../../../packages/sdk/src/signin';
import {
  authErrorFor,
  googleAuthUrl,
  idTokenFromRedirect,
  isApiFailure,
  normalizeApiBaseUrl,
  unverifiedJwtAccount,
  type ApiFailure,
  type AuthErrorCode,
} from './account-core';
import type { AccountStatus } from './messages';

const API_URL_KEY = 'my-secrect.ext.api-base-url.v1';
const ACCOUNT_KEY = 'my-secrect.ext.account.v1';
const DEVICE_PLATFORM = 'extension';
/** Fires at the session's expiry so an unlocked vault locks with it. */
export const SESSION_ALARM = 'my-secrect-session-expiry';
const VERIFY_WINDOW_MS = 60_000;

/** The hosted My Secret cloud; VITE_API_BASE_URL (and the options override in development builds) is for developers only. */
const DEFAULT_API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL || HOSTED_API_BASE_URL) ?? '';

interface AccountRecord {
  apiBaseUrl: string;
  email: string;
  session?: { token: string; expiresAt: number };
  pending?: { kind: 'email-code' } | { kind: 'mfa'; mfaToken: string };
}

/** A sign-in failure the popup can name. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
  }
}

/**
 * Device proof waiting for the MFA step to finish, to record the device id
 * the server confirms. Worker memory only; if the worker restarts in
 * between, the next sign-in simply enrols the device again.
 */
let mfaProof: PreparedDeviceProof | null = null;

/** The token this worker received or verified with the server, and when. Worker memory only. */
let verified: { token: string; apiBaseUrl: string; at: number } | null = null;

let onSignedOut: () => Promise<void> = async () => undefined;

/** background.ts: what to do whenever the account session ends (lock the vault). */
export function setSignedOutHandler(handler: () => Promise<void>): void {
  onSignedOut = handler;
}

/** The one path for every end of a session: forget it here, then let the background lock. */
async function dropSession(): Promise<void> {
  verified = null;
  mfaProof = null;
  await writeRecord(null);
  await chrome.alarms.clear(SESSION_ALARM);
  await onSignedOut();
}

async function readRecord(): Promise<AccountRecord | null> {
  const stored = await chrome.storage.session.get(ACCOUNT_KEY);
  const rec = stored[ACCOUNT_KEY] as AccountRecord | undefined;
  return rec && typeof rec === 'object' && typeof rec.apiBaseUrl === 'string' ? rec : null;
}

async function writeRecord(rec: AccountRecord | null): Promise<void> {
  if (rec) await chrome.storage.session.set({ [ACCOUNT_KEY]: rec });
  else await chrome.storage.session.remove(ACCOUNT_KEY);
}

async function apiBaseOverride(): Promise<string> {
  const stored = await chrome.storage.local.get(API_URL_KEY);
  const value = stored[API_URL_KEY];
  return typeof value === 'string' ? normalizeApiBaseUrl(value) ?? '' : '';
}

export async function apiBaseUrl(): Promise<string> {
  return (await apiBaseOverride()) || DEFAULT_API_BASE_URL;
}

async function requireApiBaseUrl(): Promise<string> {
  const base = await apiBaseUrl();
  if (!base) throw new AuthError('server-not-configured');
  return base;
}

/** JSON call to the account API. Throws ApiFailure (status 0 = never reached the server). */
async function api<T>(base: string, path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw { status: 0, error: 'offline' } satisfies ApiFailure;
  }
  if (!res.ok) {
    let error = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === 'string') error = body.error;
    } catch {
      error = '';
    }
    throw { status: res.status, error } satisfies ApiFailure;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * The stored record when it belongs to the configured server (never an
 * empty or malformed one) and its session has not expired. Anything else is
 * dropped through the signed-out path.
 */
async function liveRecord(): Promise<AccountRecord | null> {
  const rec = await readRecord();
  if (!rec) return null;
  const base = await apiBaseUrl();
  const serverOk = Boolean(base) && rec.apiBaseUrl === base && normalizeApiBaseUrl(rec.apiBaseUrl) === rec.apiBaseUrl;
  const sessionOk = !rec.session || (typeof rec.session.token === 'string' && rec.session.token.length > 0
    && typeof rec.session.expiresAt === 'number' && Date.now() < rec.session.expiresAt);
  if (!serverOk || !sessionOk) {
    await dropSession();
    return null;
  }
  return rec;
}

export async function isSignedIn(): Promise<boolean> {
  return Boolean((await liveRecord())?.session);
}

export async function accountStatus(): Promise<AccountStatus> {
  const rec = await liveRecord();
  const base = await apiBaseUrl();
  const step: AccountStatus['step'] = rec?.session ? 'signed-in' : rec?.pending ? rec.pending.kind : 'signed-out';
  return {
    step,
    email: rec?.email || null,
    serverConfigured: Boolean(base),
    apiBaseUrl: base,
    apiBaseUrlOverride: await apiBaseOverride(),
  };
}

/**
 * Ask the server whether the stored session is alive. true = alive, false =
 * gone (401: dropped through the signed-out path), null = no answer.
 */
async function askServer(rec: AccountRecord & { session: { token: string } }): Promise<boolean | null> {
  try {
    await api(rec.apiBaseUrl, '/v1/auth/sessions', { token: rec.session.token });
    verified = { token: rec.session.token, apiBaseUrl: rec.apiBaseUrl, at: Date.now() };
    return true;
  } catch (e) {
    if (!isApiFailure(e) || e.status !== 401) return null;
    await dropSession();
    return false;
  }
}

/** Popup opened: a 401 means signed out (and the vault locks). Offline keeps the display state. */
export async function checkSession(): Promise<void> {
  const rec = await liveRecord();
  if (rec?.session) await askServer(rec as AccountRecord & { session: { token: string } });
}

/**
 * The gate for createVault / unlock / unlockRecovery / restoreBackup. A
 * storage.session record alone proves nothing (extension pages can write
 * it): the token must have been received or verified by THIS worker within
 * VERIFY_WINDOW_MS, or the server must confirm it now. Without an answer
 * from the server only a token this worker lifetime already trusted passes.
 */
export async function verifySessionForVault(): Promise<boolean> {
  const rec = await liveRecord();
  const token = rec?.session?.token;
  if (!rec || !token) return false;
  const known = verified && verified.token === token && verified.apiBaseUrl === rec.apiBaseUrl ? verified : null;
  if (known && Date.now() - known.at < VERIFY_WINDOW_MS) return true;
  const alive = await askServer(rec as AccountRecord & { session: { token: string } });
  return alive === true || (alive === null && known !== null);
}

/** Session alarm fired: drop the session if it has expired (liveRecord does). */
export async function expireIfDue(): Promise<void> {
  await liveRecord();
}

/** Which sign-in buttons to show. Apple is never offered here (README: "Account sign-in"). */
export async function providers(): Promise<{ google: boolean }> {
  const base = await requireApiBaseUrl();
  try {
    const res = await api<{ google?: { extension_client_id?: unknown } | null }>(base, '/v1/auth/providers');
    return { google: typeof res?.google?.extension_client_id === 'string' && res.google.extension_client_id.length > 0 };
  } catch (e) {
    throw new AuthError(authErrorFor(e, 'oauth'));
  }
}

async function prepareProof(scope: string, challenge: string): Promise<PreparedDeviceProof | null> {
  try {
    return await prepareSignInDeviceProof(scope, challenge, DEVICE_PLATFORM);
  } catch {
    return null; // no device store: the session is simply unbound (the server allows it)
  }
}

/** Call `send` with a device proof over `challenge`; on a rejected proof drop the key and try once with a fresh one. */
async function withDeviceProof<R>(
  scope: string,
  challenge: string,
  send: (device: SignInDeviceProof | undefined) => Promise<R>,
): Promise<{ result: R; proof: PreparedDeviceProof | null }> {
  let proof = await prepareProof(scope, challenge);
  try {
    return { result: await send(proof?.proof), proof };
  } catch (e) {
    if (!proof || !isApiFailure(e) || e.status !== 401 || e.error !== 'device_verification_failed') throw e;
    await proof.reject();
    proof = await prepareProof(scope, challenge);
    return { result: await send(proof?.proof), proof };
  }
}

interface SignInResult {
  /** Present only if the server names the verified account email. */
  email?: string;
  token?: string;
  expires_in?: number;
  device_id?: string | null;
  mfa_required?: boolean;
  mfa_token?: string;
}

async function finishSignIn(base: string, email: string, result: SignInResult, proof: PreparedDeviceProof | null): Promise<AccountStatus> {
  if (result?.mfa_required === true && typeof result.mfa_token === 'string' && result.mfa_token) {
    mfaProof = proof;
    await writeRecord({ apiBaseUrl: base, email, pending: { kind: 'mfa', mfaToken: result.mfa_token } });
    return accountStatus();
  }
  if (typeof result?.token !== 'string' || !result.token) throw new AuthError('verification-failed');
  const ttl = typeof result.expires_in === 'number' && result.expires_in > 0 ? result.expires_in : 3600;
  const expiresAt = Date.now() + ttl * 1000;
  await writeRecord({ apiBaseUrl: base, email, session: { token: result.token, expiresAt } });
  verified = { token: result.token, apiBaseUrl: base, at: Date.now() };
  await chrome.alarms.create(SESSION_ALARM, { when: expiresAt });
  mfaProof = null;
  await proof?.confirm(result.device_id).catch(() => undefined);
  return accountStatus();
}

export async function requestEmailCode(rawEmail: string): Promise<AccountStatus> {
  const base = await requireApiBaseUrl();
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) throw new AuthError('invalid-email');
  try {
    await api(base, '/v1/auth/email/request', { body: { email } });
  } catch (e) {
    throw new AuthError(authErrorFor(e, 'request'));
  }
  mfaProof = null;
  await writeRecord({ apiBaseUrl: base, email, pending: { kind: 'email-code' } });
  return accountStatus();
}

export async function verifyEmailCode(rawCode: string): Promise<AccountStatus> {
  const rec = await liveRecord();
  if (rec?.pending?.kind !== 'email-code') throw new AuthError('code-expired');
  const { apiBaseUrl: base, email } = rec;
  const code = rawCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) throw new AuthError('code-failed');
  let ticket: string;
  try {
    const res = await api<{ registration_ticket?: string }>(base, '/v1/auth/email/verify', { body: { email, code } });
    if (typeof res?.registration_ticket !== 'string') throw { status: 401, error: 'verification_failed' } satisfies ApiFailure;
    ticket = res.registration_ticket;
  } catch (e) {
    throw new AuthError(authErrorFor(e, 'code'));
  }
  try {
    const { result, proof } = await withDeviceProof(deviceKeyScope(base, email), ticket, (device) =>
      api<SignInResult>(base, '/v1/auth/email/session', { body: { email, registration_ticket: ticket, ...(device ? { device } : {}) } }),
    );
    return await finishSignIn(base, email, result, proof);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    const code = authErrorFor(e, 'session');
    if (code === 'code-expired') await writeRecord(null); // the ticket is spent: start again from the email
    throw new AuthError(code);
  }
}

export async function verifyMfa(rawCode: string): Promise<AccountStatus> {
  const rec = await liveRecord();
  if (rec?.pending?.kind !== 'mfa') throw new AuthError('mfa-failed');
  const code = rawCode.trim();
  if (!code) throw new AuthError('mfa-failed');
  const { apiBaseUrl: base, email } = rec;
  const mfaToken = rec.pending.mfaToken;
  // The MFA token is single-use whatever the answer: never keep it for a retry.
  await writeRecord(null);
  const pendingProof = mfaProof;
  try {
    const result = await api<SignInResult>(base, '/v1/auth/mfa/verify', { body: { mfa_token: mfaToken, code } });
    return await finishSignIn(base, email || (typeof result?.email === 'string' ? normalizeEmail(result.email) : ''), result, pendingProof);
  } catch (e) {
    mfaProof = null;
    if (e instanceof AuthError) throw e;
    throw new AuthError(authErrorFor(e, 'mfa'));
  }
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign in with Google: OIDC id_token through chrome.identity.launchWebAuthFlow
 * (redirect https://<extension-id>.chromiumapp.org/), the raw server nonce in
 * the token, a device proof over the same nonce.
 */
export async function signInWithGoogle(): Promise<AccountStatus> {
  const base = await requireApiBaseUrl();
  let clientId: string | undefined;
  let start: { ticket?: string; nonce?: string };
  try {
    const res = await api<{ google?: { extension_client_id?: string } | null }>(base, '/v1/auth/providers');
    clientId = res?.google?.extension_client_id;
    if (!clientId) throw new AuthError('provider-unavailable');
    start = await api(base, '/v1/auth/oauth/start', { body: {} });
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(authErrorFor(e, 'oauth'));
  }
  const { ticket, nonce } = start;
  if (typeof ticket !== 'string' || typeof nonce !== 'string') throw new AuthError('unknown');
  const redirectUri = chrome.identity.getRedirectURL();
  const state = randomHex(16);
  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: googleAuthUrl({ clientId, redirectUri, nonce, state }),
      interactive: true,
    });
  } catch {
    throw new AuthError('cancelled');
  }
  const idToken = idTokenFromRedirect(responseUrl, redirectUri, state);
  if (!idToken) throw new AuthError('cancelled');
  const account = unverifiedJwtAccount(idToken) ?? 'google';
  try {
    const { result, proof } = await withDeviceProof(deviceKeyScope(base, account), nonce, (device) =>
      api<SignInResult>(base, '/v1/auth/oauth/google/session', { body: { ticket, id_token: idToken, ...(device ? { device } : {}) } }),
    );
    // Show only what the server verified: the id_token's email is unverified here.
    const verifiedEmail = typeof result?.email === 'string' ? normalizeEmail(result.email) : '';
    return await finishSignIn(base, verifiedEmail, result, proof);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(authErrorFor(e, 'oauth'));
  }
}

/** Drop a half-finished sign-in (wrong email, gave up on the code). */
export async function cancelSignIn(): Promise<AccountStatus> {
  const rec = await readRecord();
  if (rec && !rec.session) await writeRecord(null);
  mfaProof = null;
  return accountStatus();
}

/** Revoke this session on the server (best effort) and forget it here. */
export async function signOut(): Promise<AccountStatus> {
  const rec = await readRecord();
  if (rec?.session) {
    const token = rec.session.token;
    try {
      const list = await api<{ sessions?: { id: string; current?: boolean }[] }>(rec.apiBaseUrl, '/v1/auth/sessions', { token });
      const current = list?.sessions?.find((s) => s.current === true);
      if (current) await api(rec.apiBaseUrl, `/v1/auth/sessions/${encodeURIComponent(current.id)}`, { method: 'DELETE', token });
    } catch {
      // Offline or already revoked: the local session is dropped anyway.
    }
  }
  await dropSession();
  return accountStatus();
}

/** Change the account server. A different server means a different account: sign out first. */
export async function setApiBaseUrl(raw: string): Promise<AccountStatus> {
  const normalized = normalizeApiBaseUrl(raw);
  if (normalized === null) throw new AuthError('invalid-server-url');
  const before = await apiBaseUrl();
  if ((normalized || DEFAULT_API_BASE_URL) !== before) await signOut();
  if (normalized) await chrome.storage.local.set({ [API_URL_KEY]: normalized });
  else await chrome.storage.local.remove(API_URL_KEY);
  return accountStatus();
}
