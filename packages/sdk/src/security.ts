/**
 * @my-secrect/sdk — SecurityApiClient (account security endpoints).
 *
 * Covers the WorkOS-inspired account-security surface the Rails backend
 * exposes under /v1/auth/*, /v1/devices/* and /v1/recovery/*:
 * passkeys, MFA (TOTP + recovery codes), sessions, trusted devices,
 * step-up verification, security activity, and account deletion.
 *
 * This client is LOCAL-FIRST aware: the desktop app constructs it ONLY
 * when an API base URL is configured (localStorage key
 * 'my-secrect:api-base-url'); with no base URL there is no client at
 * all, and every call site must render a not-configured state instead
 * of fake data. A fetch failure (offline / wrong URL) surfaces as the
 * underlying TypeError — callers map that to an offline state, never
 * to invented data.
 *
 * The SDK sends ONLY opaque ids, public keys and one-time codes. It
 * never sends vault keys, plaintext items, passphrases or recovery
 * keys, and it never logs request bodies.
 *
 * Account auth is SEPARATE from vault unlock: a session token here
 * never unlocks the local vault, and the master passphrase never
 * leaves the device.
 *
 * Step-up: a fresh step-up verification is valid for 10 minutes
 * (STEP_UP_WINDOW_MS). When the server answers 403 with
 * `step_up_required`, the caller must re-prompt, not proceed — see
 * isStepUpRequired() and the mirror test
 * tests/security/step-up-client.test.mjs.
 */
import { ApiError } from './index';
import type { ApiClientConfig } from './index';

export { ApiError };
export type { ApiClientConfig };

/** localStorage / AsyncStorage key where the account session token
 *  lives once a sign-in flow has produced one. Populated by the
 *  desktop/web SignInScreen and the mobile SignInScreen via
 *  saveSessionToken() below; read back through getValidToken(),
 *  which returns null when there is no token OR when it has
 *  expired, so server calls never go out with a stale token (the
 *  server would answer 401, which the UI surfaces as a re-sign-in
 *  prompt, never as fake data). The token is an opaque Bearer
 *  session token ("sess_" + 64 hex chars, 1 h TTL; recovery
 *  sessions 15 min). It is account auth only — it never unlocks
 *  the vault and must never be stored next to a passphrase. */
export const LS_API_TOKEN = 'my-secrect:api-token';
/** Epoch-ms at which the stored token expires (set by
 *  saveSessionToken from the server's `expires_in`). Absent =
 *  unknown expiry: the token is sent and the server decides. */
export const LS_API_TOKEN_EXPIRES_AT = 'my-secrect:api-token-expires-at';
/** Email of the signed-in account, for display + prefill only.
 *  Not a secret, not an auth credential on its own. */
export const LS_ACCOUNT_EMAIL = 'my-secrect:account-email';

/** Minimal key/value store so one token-storage implementation
 *  serves localStorage (desktop/web, synchronous) and AsyncStorage
 *  (mobile, async). Apps pass their platform store; nobody invents
 *  a second token key or a second store. */
export interface TokenStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** A localStorage-backed TokenStore (desktop/web). Every access is
 *  guarded: a full or blocked localStorage must never throw into a
 *  sign-in flow. */
export function webTokenStore(): TokenStore {
  return {
    getItem: (key) => {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    setItem: (key, value) => {
      try { localStorage.setItem(key, value); } catch { /* non-critical */ }
    },
    removeItem: (key) => {
      try { localStorage.removeItem(key); } catch { /* non-critical */ }
    },
  };
}

/** Store a freshly issued session token + its expiry. `expiresIn`
 *  is the server's `expires_in` in seconds. Never logs the token. */
export async function saveSessionToken(store: TokenStore, token: string, expiresIn?: number): Promise<void> {
  await store.setItem(LS_API_TOKEN, token);
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    await store.setItem(LS_API_TOKEN_EXPIRES_AT, String(Date.now() + expiresIn * 1000));
  } else {
    await store.removeItem(LS_API_TOKEN_EXPIRES_AT);
  }
}

/** Raw stored token, ignoring expiry. Prefer getValidToken(). */
export async function readStoredToken(store: TokenStore): Promise<string | null> {
  try { return await store.getItem(LS_API_TOKEN); } catch { return null; }
}

/** The stored token when it exists AND has not expired; null
 *  otherwise (no token, or past its stored expiry). An expired
 *  token is removed best-effort so a later read cannot resurrect
 *  it. Never throws. */
export async function getValidToken(store: TokenStore, now: number = Date.now()): Promise<string | null> {
  const token = await readStoredToken(store);
  if (!token) return null;
  let expiresAt: string | null = null;
  try { expiresAt = await store.getItem(LS_API_TOKEN_EXPIRES_AT); } catch { expiresAt = null; }
  if (expiresAt !== null) {
    const at = Number(expiresAt);
    if (Number.isFinite(at) && now >= at) {
      await clearSessionToken(store);
      return null;
    }
  }
  return token;
}

/** Synchronous version for desktop boot (localStorage only): the
 *  same expiry rule as getValidToken, without awaiting. */
export function getValidTokenSync(store: { getItem(key: string): string | null }, now: number = Date.now()): string | null {
  let token: string | null = null;
  try { token = store.getItem(LS_API_TOKEN); } catch { return null; }
  if (!token) return null;
  let expiresAt: string | null = null;
  try { expiresAt = store.getItem(LS_API_TOKEN_EXPIRES_AT); } catch { expiresAt = null; }
  if (expiresAt !== null) {
    const at = Number(expiresAt);
    if (Number.isFinite(at) && now >= at) {
      try { store.removeItem?.(LS_API_TOKEN); } catch { /* non-critical */ }
      return null;
    }
  }
  return token;
}

/** Remove the token, its expiry, and the stored account email. */
export async function clearSessionToken(store: TokenStore): Promise<void> {
  for (const key of [LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, LS_ACCOUNT_EMAIL]) {
    try { await store.removeItem(key); } catch { /* non-critical */ }
  }
}

/** Adopt a `rotated_token` from a privilege-change response (MFA
 *  enable/disable, passkey add/remove, recovery-code regenerate).
 *  The server rotates the session so a token stolen before the
 *  change stops working; the client must persist the fresh token
 *  or its next call goes out with the revoked one. The expiry is
 *  kept from the previous token when known (rotation preserves the
 *  session's TTL class); when unknown, no expiry is stored and the
 *  server decides per call. Returns true when a token was adopted. */
export async function adoptRotatedToken(store: TokenStore, res: unknown): Promise<boolean> {
  if (typeof res !== 'object' || res === null) return false;
  const rotated = (res as Record<string, unknown>).rotated_token;
  if (typeof rotated !== 'string' || !rotated) return false;
  await store.setItem(LS_API_TOKEN, rotated);
  return true;
}

/** True when the failure is an unauthenticated (401) API response:
 *  missing, revoked, or expired session token. Callers send the
 *  user back to SignIn on 401 and never silently retry with the
 *  same stale token. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** A step-up verification stays valid for 10 minutes. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

/** True when `verifiedAt` is a step-up verification inside the window. */
export function isStepUpFresh(verifiedAt: number | null | undefined, now: number = Date.now()): boolean {
  if (verifiedAt === null || verifiedAt === undefined) return false;
  return now - verifiedAt <= STEP_UP_WINDOW_MS;
}

/**
 * True when the server refused with step-up required: HTTP 403 whose
 * error body says `step_up_required`. ApiError carries the body inside
 * its message (`API <status> <path>: <json>`), so the check is a status
 * check plus a substring match on that message. Any other error —
 * including a 403 for another reason — is NOT step-up required.
 */
export function isStepUpRequired(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 403 && error.message.includes('step_up_required');
}

export interface PasskeyAuthenticator {
  id: string;
  credential_id_prefix: string;
  sign_count: number;
  created_at: string;
}

export interface PasskeyListResponse {
  authenticators: PasskeyAuthenticator[];
}

export interface MfaEnrollResponse {
  otpauth_url: string;
  /** Shown once by the server. The client displays it once and never persists it. */
  secret: string;
}

export interface RecoveryCodesResponse {
  /** Shown once. Each code is single-use; regenerating invalidates
   *  the old set. NOTE: the server's wire key is `recovery_codes`
   *  (MfaController#regenerate_codes / Totp.confirm) — NOT `codes`.
   *  An earlier SDK type said `codes`, so both Security Centers read
   *  `res.codes` and always got `undefined`. Fixed 17 Nov 2026. */
  recovery_codes: string[];
  /** Fresh session token (rotation on privilege change). Adopt it. */
  rotated_token?: string;
}

export interface MfaConfirmResponse {
  mfa_enabled: boolean;
  /** Shown once at confirm time. Wire key is `recovery_codes`. */
  recovery_codes: string[];
  rotated_token?: string;
}

/** A completed sign-in: full Bearer session. `expires_in` is
 *  seconds (3600 for a passkey/MFA session, 900 for a recovery
 *  session). `recovery_session` is true only for sessions minted
 *  by POST /v1/recovery/verify — 15 minutes, step-up verified at
 *  issue, meant for recovery actions, not daily use. */
export interface SessionResult {
  token: string;
  user_id: string;
  device_id?: string | null;
  expires_in: number;
  recovery_session?: boolean;
}

/** Passkey assertion verified, but the account has MFA enabled:
 *  NO session is issued yet. The client must complete the login
 *  with POST /v1/auth/mfa/verify + the single-use `mfa_token`
 *  (5 min) and a TOTP code or a recovery code. */
export interface MfaRequiredResult {
  mfa_required: true;
  mfa_token: string;
  user_id: string;
}

export type SignInResult = SessionResult | MfaRequiredResult;

/** True when the verify response parked the login at MFA. */
export function isMfaRequiredResult(res: SignInResult): res is MfaRequiredResult {
  return (res as MfaRequiredResult).mfa_required === true;
}

export interface PasskeyRegisterOptionsResponse {
  user: { id: string; email: string };
  creation_options: unknown;
}

export interface PasskeyAuthenticateOptionsResponse {
  request_options: unknown;
}

export interface SessionInfo {
  id: string;
  device_id: string;
  user_agent: string;
  ip_address: string;
  created_at: string;
  expires_at: string;
  current: boolean;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
}

export interface DeviceInfo {
  id: string;
  /** Vault-Key-encrypted display name (opaque to the server), if the device set one. */
  name_encrypted?: string | null;
  name?: string | null;
  platform?: string | null;
  user_agent?: string | null;
  trusted?: boolean;
  last_seen_at?: string | null;
  created_at?: string | null;
  current?: boolean;
}

export interface DeviceListResponse {
  devices: DeviceInfo[];
}

export interface ActivityEvent {
  event_type: string;
  device_id: string;
  created_at: string;
}

export interface ActivityResponse {
  events: ActivityEvent[];
}

export interface RecoveryChallengeResponse {
  challenge_id: string;
  challenge: string;
  expires_in: number;
}

export class SecurityApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;
  /** Optional token store for automatic rotation adoption: any
   *  response carrying `rotated_token` (privilege changes rotate
   *  the session) is persisted here, so the next call never goes
   *  out with the revoked token. Apps pass their platform store
   *  (webTokenStore() on desktop/web, an AsyncStorage adapter on
   *  mobile). When absent, callers must adopt rotated_token
   *  themselves via adoptRotatedToken(). */
  private readonly tokenStore?: TokenStore;

  constructor(cfg: ApiClientConfig & { tokenStore?: TokenStore }) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.getToken = cfg.getToken;
    this.tokenStore = cfg.tokenStore;
  }

  /** Same shape as VaultApiClient.req: Bearer token when present,
   *  ApiError on non-2xx, empty bodies (e.g. 204 on DELETE) tolerated.
   *  Request bodies are never logged. */
  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw new ApiError(res.status, path, body);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
    // Rotation adoption (see constructor): a privilege change
    // revokes the old session server-side, so persist the fresh
    // token now. Best-effort and silent — a store failure must not
    // turn a successful server call into an error.
    if (this.tokenStore && typeof parsed === 'object' && parsed !== null) {
      const rotated = (parsed as Record<string, unknown>).rotated_token;
      if (typeof rotated === 'string' && rotated) {
        void adoptRotatedToken(this.tokenStore, parsed).catch(() => undefined);
      }
    }
    return parsed;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.req<T>(path, {
      method: 'POST',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private del<T>(path: string): Promise<T> {
    return this.req<T>(path, { method: 'DELETE' });
  }

  // --- Passkeys ------------------------------------------------------------
  listPasskeys(): Promise<PasskeyListResponse> {
    return this.req<PasskeyListResponse>('/v1/auth/passkeys');
  }

  /** Options for registering a new passkey (WebAuthn creation). */
  passkeyAddOptions(): Promise<{ creation_options: unknown }> {
    return this.post<{ creation_options: unknown }>('/v1/auth/passkeys/add/options');
  }

  /** Verify a newly created passkey credential. The server may rotate
   *  the session token — callers adopt `rotated_token` when present. */
  passkeyAddVerify(credential: unknown): Promise<{ rotated_token?: string }> {
    return this.post<{ rotated_token?: string }>('/v1/auth/passkeys/add/verify', { credential });
  }

  /** Remove a passkey. Step-up is required server-side; the server
   *  answers 422 when this is the last sign-in method and no MFA exists.
   *  Returns the rotated session token (adopted automatically when
   *  this client was built with a tokenStore). */
  removePasskey(id: string): Promise<{ revoked: boolean; rotated_token?: string }> {
    return this.del<{ revoked: boolean; rotated_token?: string }>(`/v1/auth/passkeys/${encodeURIComponent(id)}`);
  }

  /** Request WebAuthn authentication options (login / step-up). */
  passkeyAuthenticateOptions(email: string): Promise<PasskeyAuthenticateOptionsResponse> {
    return this.post<PasskeyAuthenticateOptionsResponse>('/v1/auth/passkeys/authenticate', { email });
  }

  // --- Account sign-in (passkey-first; the API has NO password login) ---
  // The API is passkey-only by design: there is no password endpoint
  // to call, so no client may invent one. Sign-in = WebAuthn ceremony
  // + optional MFA step. A successful verify issues a Bearer session
  // token; it does NOT unlock the vault (master passphrase is a
  // separate, later step, handled by the apps, never by this client).
  //
  // Create account (first passkey): register options ->
  // navigator.credentials.create -> registerVerify(kind 'registration').
  // Sign in: authenticate options -> navigator.credentials.get ->
  // loginVerify(kind 'authentication') -> SessionResult, or
  // MfaRequiredResult when the account has MFA enabled.
  // Challenges are single-use, 5 minutes; a failed or expired
  // attempt burns the challenge and the caller must request fresh
  // options — never retry the same credential payload.
  passkeyRegisterOptions(email: string): Promise<PasskeyRegisterOptionsResponse> {
    return this.post<PasskeyRegisterOptionsResponse>('/v1/auth/passkeys/register', { email });
  }

  passkeyRegisterVerify(email: string, credential: unknown): Promise<SessionResult> {
    return this.post<SessionResult>('/v1/auth/passkeys/verify', { email, credential, kind: 'registration' });
  }

  passkeyLoginVerify(email: string, credential: unknown): Promise<SignInResult> {
    return this.post<SignInResult>('/v1/auth/passkeys/verify', { email, credential, kind: 'authentication' });
  }

  // --- MFA (TOTP + recovery codes) ------------------------------------------
  /** Start MFA enrollment. Returns the otpauth URL + secret (shown once). */
  mfaEnroll(): Promise<MfaEnrollResponse> {
    return this.post<MfaEnrollResponse>('/v1/auth/mfa/enroll');
  }

  /** Confirm enrollment with a TOTP code from the authenticator app.
   *  Returns the recovery codes (wire key `recovery_codes`) + a
   *  rotated session token, which req() adopts automatically when
   *  this client was built with a tokenStore. */
  mfaConfirm(code: string): Promise<MfaConfirmResponse> {
    return this.post<MfaConfirmResponse>('/v1/auth/mfa/confirm', { code });
  }

  /** Second factor at login: exchange a single-use mfa_token + a
   *  TOTP code (6 digits) or a recovery code (XXXX-XXXX). The token
   *  is consumed server-side whether the code is right or wrong, so
   *  a failed attempt must restart the login from fresh passkey
   *  options — never retry verify with the same mfa_token. On
   *  success returns the full session. */
  mfaVerify(mfaToken: string, code: string): Promise<SessionResult> {
    return this.post<SessionResult>('/v1/auth/mfa/verify', { mfa_token: mfaToken, code });
  }

  /** Disable MFA. Step-up is required server-side.
   *  FIX 17 Nov 2026: this used DELETE /v1/auth/mfa, which has no
   *  route — the real endpoint is POST /v1/auth/mfa/disable (and it
   *  rotates the session token). */
  mfaDisable(): Promise<{ mfa_enabled: false; rotated_token?: string }> {
    return this.post<{ mfa_enabled: false; rotated_token?: string }>('/v1/auth/mfa/disable');
  }

  /** Permanently delete the signed-in account. Step-up is required
   *  server-side. The server deletes only that account and answers 204.
   *  A 403 whose body says step_up_required must re-prompt, not proceed. */
  deleteAccount(): Promise<void> {
    return this.del<void>('/v1/auth/account');
  }

  /** Regenerate recovery codes (shown once, single-use). Step-up required.
   *  FIX 17 Nov 2026: this posted /v1/auth/mfa/recovery-codes, which
   *  has no route — the real endpoint is POST
   *  /v1/auth/mfa/recovery_codes (underscore), and the wire key is
   *  `recovery_codes`. */
  mfaRecoveryCodes(): Promise<RecoveryCodesResponse> {
    return this.post<RecoveryCodesResponse>('/v1/auth/mfa/recovery_codes');
  }

  // --- Sessions --------------------------------------------------------------
  listSessions(): Promise<SessionListResponse> {
    return this.req<SessionListResponse>('/v1/auth/sessions');
  }

  revokeSession(id: string): Promise<void> {
    return this.del<void>(`/v1/auth/sessions/${encodeURIComponent(id)}`);
  }

  /** Revoke every session except the current one. Step-up required.
   *  Revocation invalidates server sessions only — it does NOT erase
   *  secrets already downloaded or stored offline on those devices. */
  revokeOtherSessions(): Promise<void> {
    return this.del<void>('/v1/auth/sessions/others');
  }

  /** Sign out of THIS device: find the session flagged `current`
   *  and revoke it server-side (DELETE /v1/auth/sessions/:id).
   *  Returns true when the server confirmed the revocation, false
   *  when no current session could be found (already revoked or
   *  expired server-side — the caller still clears the local token:
   *  local sign-out never depends on the server answering). There
   *  is no dedicated logout endpoint; revoking the current session
   *  IS the logout. Revocation invalidates the server session only;
   *  it does NOT erase secrets already downloaded or cached offline
   *  on this device. Callers clear the stored token and lock the
   *  vault after this returns, whatever it returns. */
  async revokeCurrentSession(): Promise<boolean> {
    const list = await this.listSessions();
    const current = (list.sessions ?? []).find((s) => s.current);
    if (!current) return false;
    await this.revokeSession(current.id);
    return true;
  }

  // --- Devices ---------------------------------------------------------------
  listDevices(): Promise<DeviceListResponse> {
    return this.req<DeviceListResponse>('/v1/devices');
  }

  /** Rename (name_encrypted is Vault-Key-encrypted, opaque to the
   *  server) and/or (un)trust a device. Trusting requires step-up. */
  updateDevice(id: string, body: { name_encrypted?: string; trusted?: boolean }): Promise<unknown> {
    return this.req(`/v1/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /** Enroll this device. Step-up required server-side. */
  enrollDevice(): Promise<unknown> {
    return this.post('/v1/devices/enroll');
  }

  // --- Step-up ---------------------------------------------------------------
  /** Verify a step-up with a TOTP code. */
  stepUpTotp(code: string): Promise<unknown> {
    return this.post('/v1/auth/step-up/totp', { code });
  }

  /** Verify a step-up with a passkey assertion (after authenticate options). */
  stepUpPasskey(credential: unknown): Promise<unknown> {
    return this.post('/v1/auth/step-up/passkey', { credential });
  }

  // --- Security activity -----------------------------------------------------
  /** Recent account security events (server caps the list at 50). */
  listActivity(): Promise<ActivityResponse> {
    return this.req<ActivityResponse>('/v1/auth/activity');
  }

  // --- Recovery --------------------------------------------------------------
  /** Start a recovery challenge for an email + kind. */
  recoveryChallenge(email: string, kind: string): Promise<RecoveryChallengeResponse> {
    return this.post<RecoveryChallengeResponse>('/v1/recovery/challenges', { email, kind });
  }

  /** Answer a recovery challenge with an Ed25519 signature over the
   *  challenge bytes (base64 signature, standard or URL-safe). On
   *  success returns a 15-minute RECOVERY session
   *  (recovery_session: true, step-up verified at issue) — an
   *  account session for recovery actions, not a daily sign-in.
   *  Requires a recovery verifier registered for the account first;
   *  without one every attempt fails with a generic 401. */
  recoveryVerify(challengeId: string, email: string, signature: string): Promise<SessionResult> {
    return this.post<SessionResult>('/v1/recovery/verify', { challenge_id: challengeId, email, signature });
  }

  /** Register a recovery verifier: ONLY the Ed25519 public key is sent.
   *  The private key is derived from the recovery key on-device and
   *  never leaves the device. Authenticated + step-up server-side. */
  registerRecoveryVerifier(publicKey: string): Promise<unknown> {
    return this.post('/v1/recovery/verifiers', { public_key: publicKey });
  }
}
