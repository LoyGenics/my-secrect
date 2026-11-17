/**
 * @my-secrect/sdk — sign-in state machine (pure, no fetch, no DOM).
 *
 * The ONE set of rules every sign-in screen follows (desktop, web,
 * mobile recovery sign-in):
 *
 *   email --(valid email)--> passkey --(assertion verified)--> signed-in
 *   email --(valid email)--> passkey --(mfa_required)--> mfa --(code ok)--> signed-in
 *   create-account uses the same steps with kind 'registration'.
 *
 * Server facts these rules encode (see apps/api, do not change here
 * without changing the server too):
 *   * The API is passkey-only. There is no password login endpoint.
 *   * A WebAuthn challenge is single-use and lives 5 minutes. A
 *     failed, expired, or cancelled attempt burns it: the caller
 *     must request FRESH options and start the ceremony again.
 *     Never retry the same credential payload.
 *   * `verify` with kind 'authentication' returns either a session
 *     ({ token, expires_in }) or { mfa_required: true, mfa_token }.
 *     The mfa_token is ALSO single-use and 5 minutes: it is consumed
 *     server-side whether the MFA code is right or wrong, so a
 *     failed MFA attempt must restart the login from the email step
 *     — never retry verify with the same mfa_token.
 *   * A TOTP code and a recovery code are interchangeable at the MFA
 *     step (the server tries TOTP first, then the recovery-code
 *     digest); the machine does not distinguish them.
 *   * A session token never unlocks the vault. 'signed-in' here
 *     means ACCOUNT signed in only; the master passphrase is still
 *     required afterwards, as a separate step.
 *
 * The machine never touches the network, storage, or the DOM, so
 * the plain-Node mirror tests in tests/security/signin-client.test.mjs
 * can exercise the same rules without a TS loader. Those tests
 * MIRROR this file (they do not import it); keep the two in sync
 * and say so in the test header.
 */

export type SignInStep = 'email' | 'passkey' | 'mfa' | 'signed-in';
export type SignInMode = 'login' | 'create';

export type SignInErrorKind =
  | 'invalid-email'
  | 'webauthn-unavailable'
  | 'passkey-cancelled'
  | 'verification-failed'
  | 'challenge-expired'
  | 'mfa-expired'
  | 'offline'
  | 'unknown';

export interface SignInState {
  step: SignInStep;
  mode: SignInMode;
  /** Normalised (trimmed, lower-cased) account email, or ''. */
  email: string;
  /** Pending single-use MFA token, only while step === 'mfa'. */
  mfaToken: string | null;
  error: SignInErrorKind | null;
  /** True while a network/ceremony call is in flight. */
  busy: boolean;
}

export function initialSignInState(mode: SignInMode = 'login'): SignInState {
  return { step: 'email', mode, email: '', mfaToken: null, error: null, busy: false };
}

/** Loose email check: non-empty, one '@', something on both sides,
 *  no spaces. The server is the authority on whether the address
 *  exists (and it never leaks that); this only catches typos early. */
export function isValidEmail(email: string): boolean {
  const at = email.indexOf('@');
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1 && !/\s/.test(email);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** email step -> passkey step. Rejects a bad email without leaving
 *  the email step. */
export function startSignIn(state: SignInState, email: string, mode: SignInMode): SignInState {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ...state, step: 'email', mode, email: normalized, mfaToken: null, error: 'invalid-email', busy: false };
  }
  return { ...state, step: 'passkey', mode, email: normalized, mfaToken: null, error: null, busy: true };
}

/** Server options arrived: the WebAuthn ceremony may start.
 *  Only valid from the passkey step. */
export function optionsReceived(state: SignInState): SignInState {
  if (state.step !== 'passkey') return state;
  return { ...state, busy: true, error: null };
}

/** Outcome of POST /v1/auth/passkeys/verify.
 *  - { token } -> signed-in (session issued).
 *  - { mfa_required: true, mfa_token } -> mfa step (no session yet).
 *  Only valid from the passkey step; anything else is ignored. */
export function passkeyVerified(
  state: SignInState,
  result: { token?: string; mfa_required?: boolean; mfa_token?: string },
): SignInState {
  if (state.step !== 'passkey') return state;
  if (result.mfa_required === true && typeof result.mfa_token === 'string' && result.mfa_token) {
    return { ...state, step: 'mfa', mfaToken: result.mfa_token, error: null, busy: false };
  }
  if (typeof result.token === 'string' && result.token) {
    return { ...state, step: 'signed-in', mfaToken: null, error: null, busy: false };
  }
  return { ...state, error: 'verification-failed', busy: false };
}

/** Outcome of POST /v1/auth/mfa/verify. Only valid from the mfa
 *  step, and only with a session token in the response. */
export function mfaVerified(state: SignInState, result: { token?: string }): SignInState {
  if (state.step !== 'mfa') return state;
  if (typeof result.token === 'string' && result.token) {
    return { ...state, step: 'signed-in', mfaToken: null, error: null, busy: false };
  }
  return { ...state, error: 'verification-failed', busy: false };
}

/** A failure at the current step. The step is kept, EXCEPT:
 *  - 'mfa-expired': the server consumed the single-use mfa_token,
 *    so the login must restart from the email step (fresh passkey
 *    options). The mfaToken is cleared and must never be reused.
 *  - 'challenge-expired': the WebAuthn challenge is spent; back to
 *    the email step for fresh options.
 *  - 'passkey-cancelled': the user dismissed the authenticator;
 *    stay on the passkey step so they can try again (a fresh
 *    options request is still needed — the screen re-requests).
 *  'busy' is always cleared. */
export function signInFailed(state: SignInState, kind: SignInErrorKind): SignInState {
  if (kind === 'mfa-expired' || kind === 'challenge-expired') {
    return { ...state, step: 'email', mfaToken: null, error: kind, busy: false };
  }
  return { ...state, error: kind, busy: false };
}

export function resetSignIn(mode: SignInMode = 'login'): SignInState {
  return initialSignInState(mode);
}

/** Classify a thrown failure into a SignInErrorKind. The mapping
 *  is deliberately coarse — the server returns one generic 401 for
 *  every verification failure and never says which check failed,
 *  so the UI must not claim more than it knows.
 *  - TypeError (fetch threw) -> 'offline'.
 *  - DOMException NotAllowedError (user cancelled the passkey
 *    prompt, or no authenticator) -> 'passkey-cancelled'.
 *  - ApiError-like { status: 401 } at the mfa step -> 'mfa-expired'
 *    (the single-use token is spent either way).
 *  - ApiError-like { status: 401 } elsewhere -> 'verification-failed'.
 *  - message mentioning 'challenge expired' -> 'challenge-expired'.
 *  - anything else -> 'unknown'. */
export function classifySignInError(
  err: unknown,
  step: SignInStep,
): SignInErrorKind {
  if (err instanceof TypeError) return 'offline';
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    if (rec.name === 'NotAllowedError') return 'passkey-cancelled';
    if (typeof rec.message === 'string' && /challenge expired/i.test(rec.message)) return 'challenge-expired';
    if (rec.status === 401 || rec.name === 'ApiError') {
      if (rec.status === 401) return step === 'mfa' ? 'mfa-expired' : 'verification-failed';
    }
  }
  return 'unknown';
}
