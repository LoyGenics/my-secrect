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

/** localStorage key where the account session token lives once a
 *  sign-in flow has produced one. Nothing populates it yet — the
 *  desktop has no account sign-in UI — so getToken() returns null
 *  until a sign-in flow stores a token here, and server calls go out
 *  without an Authorization header (the server then answers 401,
 *  which the UI surfaces as an error, never as fake data). */
export const LS_API_TOKEN = 'my-secrect:api-token';

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
  /** Shown once. Each code is single-use; regenerating invalidates the old set. */
  codes: string[];
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

  constructor(cfg: ApiClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.getToken = cfg.getToken;
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
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
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
   *  answers 422 when this is the last sign-in method and no MFA exists. */
  removePasskey(id: string): Promise<void> {
    return this.del<void>(`/v1/auth/passkeys/${encodeURIComponent(id)}`);
  }

  /** Request WebAuthn authentication options (login / step-up). */
  passkeyAuthenticateOptions(email: string): Promise<{ request_options: unknown }> {
    return this.post<{ request_options: unknown }>('/v1/auth/passkeys/authenticate', { email });
  }

  // --- MFA (TOTP + recovery codes) ------------------------------------------
  /** Start MFA enrollment. Returns the otpauth URL + secret (shown once). */
  mfaEnroll(): Promise<MfaEnrollResponse> {
    return this.post<MfaEnrollResponse>('/v1/auth/mfa/enroll');
  }

  /** Confirm enrollment with a TOTP code from the authenticator app. */
  mfaConfirm(code: string): Promise<unknown> {
    return this.post('/v1/auth/mfa/confirm', { code });
  }

  /** Second factor at login: exchange a mfa_token + TOTP code. */
  mfaVerify(mfaToken: string, code: string): Promise<unknown> {
    return this.post('/v1/auth/mfa/verify', { mfa_token: mfaToken, code });
  }

  /** Disable MFA. Step-up is required server-side (POST /v1/auth/mfa/disable). */
  mfaDisable(): Promise<void> {
    return this.post<void>('/v1/auth/mfa/disable');
  }

  /** Permanently delete the signed-in account. Step-up is required
   *  server-side. The server deletes only that account and answers 204.
   *  A 403 whose body says step_up_required must re-prompt, not proceed. */
  deleteAccount(): Promise<void> {
    return this.del<void>('/v1/auth/account');
  }

  /** Regenerate recovery codes (shown once, single-use). Step-up required. */
  mfaRecoveryCodes(): Promise<RecoveryCodesResponse> {
    return this.post<RecoveryCodesResponse>('/v1/auth/mfa/recovery-codes');
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

  /** Answer a recovery challenge with a signature. */
  recoveryVerify(challengeId: string, email: string, signature: string): Promise<unknown> {
    return this.post('/v1/recovery/verify', { challenge_id: challengeId, email, signature });
  }

  /** Register a recovery verifier: ONLY the Ed25519 public key is sent.
   *  The private key is derived from the recovery key on-device and
   *  never leaves the device. Authenticated + step-up server-side. */
  registerRecoveryVerifier(publicKey: string): Promise<unknown> {
    return this.post('/v1/recovery/verifiers', { public_key: publicKey });
  }
}
