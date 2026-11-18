/**
 * @my-secrect/sdk — sign-in state machine (pure, no fetch, no DOM).
 *
 * The ONE set of rules every sign-in screen follows (desktop, web,
 * mobile recovery sign-in):
 *
 *   email --(valid email)--> passkey --(assertion verified)--> signed-in
 *   email --(valid email)--> passkey --(mfa_required)--> mfa --(code ok)--> signed-in
 *   the email-code path needs no passkey (sign up, or sign in before a
 *   passkey was added): prove the address, spend the ticket for a session:
 *   email --(code requested)--> email-code --(code ok: ticket, session)--> signed-in
 *   email --(code requested)--> email-code --(mfa_required)--> mfa --(code ok)--> signed-in
 *   An account WITH a passkey cannot use it: the server mails no code for it.
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
 *   * The email-code path: POST /v1/auth/email/request mails a 6-digit
 *     code (same 202 whether or not the address already has an account —
 *     an account with a passkey gets a notice instead of a code), POST
 *     /v1/auth/email/verify trades the code for a single-use ticket (10
 *     minutes), and POST /v1/auth/email/session spends it for a session
 *     (creating the account on first use). A code allows 5 tries and is
 *     single-use; a failed device proof keeps the ticket. An expired or
 *     spent ticket ('signup-expired') restarts from the email step.
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

export type SignInStep = 'email' | 'email-code' | 'passkey' | 'mfa' | 'signed-in';
export type SignInMode = 'login' | 'create';

export type SignInErrorKind =
  | 'invalid-email'
  | 'webauthn-unavailable'
  | 'passkey-cancelled'
  | 'verification-failed'
  | 'challenge-expired'
  | 'mfa-expired'
  | 'email-code-failed'
  | 'email-unavailable'
  | 'signup-expired'
  | 'device-rejected'
  | 'device-approval-required'
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

/** email step -> passkey step (login) or email-code step (create:
 *  the code is being requested, busy). Rejects a bad email without
 *  leaving the email step. */
export function startSignIn(state: SignInState, email: string, mode: SignInMode): SignInState {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ...state, step: 'email', mode, email: normalized, mfaToken: null, error: 'invalid-email', busy: false };
  }
  const step: SignInStep = mode === 'create' ? 'email-code' : 'passkey';
  return { ...state, step, mode, email: normalized, mfaToken: null, error: null, busy: true };
}

/** email step -> email-code step for either mode: the same code flow
 *  signs an existing account in or creates a new one. Rejects a bad
 *  email without leaving the email step. */
export function startEmailSignIn(state: SignInState, email: string, mode: SignInMode): SignInState {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ...state, step: 'email', mode, email: normalized, mfaToken: null, error: 'invalid-email', busy: false };
  }
  return { ...state, step: 'email-code', mode, email: normalized, mfaToken: null, error: null, busy: true };
}

/** Outcome of POST /v1/auth/email/session (code ticket spent).
 *  - { token } -> signed-in.
 *  - { mfa_required: true, mfa_token } -> mfa step (no session yet).
 *  Only valid from the email-code step; anything else is ignored. */
export function emailSignedIn(
  state: SignInState,
  result: { token?: string; mfa_required?: boolean; mfa_token?: string },
): SignInState {
  if (state.step !== 'email-code') return state;
  if (result.mfa_required === true && typeof result.mfa_token === 'string' && result.mfa_token) {
    return { ...state, step: 'mfa', mfaToken: result.mfa_token, error: null, busy: false };
  }
  if (typeof result.token === 'string' && result.token) {
    return { ...state, step: 'signed-in', mfaToken: null, error: null, busy: false };
  }
  return { ...state, error: 'verification-failed', busy: false };
}

/** POST /v1/auth/email/request answered 202: wait for the user to type
 *  the code. Only valid from the email-code step. */
export function emailCodeSent(state: SignInState): SignInState {
  if (state.step !== 'email-code') return state;
  return { ...state, busy: false, error: null };
}

/** POST /v1/auth/email/request failed (malformed address, mail
 *  unavailable, offline): no code exists, so back to the email step. */
export function emailCodeRequestFailed(state: SignInState, kind: SignInErrorKind): SignInState {
  return { ...state, step: 'email', mfaToken: null, error: kind, busy: false };
}

/** POST /v1/auth/email/verify returned a registration ticket: the
 *  passkey registration ceremony may start (legacy passkey sign-up; the
 *  screen uses emailSignedIn instead). Only valid from the email-code step. */
export function emailCodeVerified(state: SignInState): SignInState {
  if (state.step !== 'email-code') return state;
  return { ...state, step: 'passkey', busy: true, error: null };
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
 *  - 'signup-expired' / 'email-unavailable': the registration ticket
 *    is gone (or no code could be sent): back to the email step.
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
  if (kind === 'mfa-expired' || kind === 'challenge-expired' || kind === 'signup-expired' || kind === 'email-unavailable') {
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
 *  - at the email-code step: 401 -> 'email-code-failed', 503 ->
 *    'email-unavailable', 422 -> 'invalid-email'.
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
    if (step === 'email-code') {
      if (rec.status === 401) return 'email-code-failed';
      if (rec.status === 503) return 'email-unavailable';
      if (rec.status === 422) return 'invalid-email';
    }
    if (rec.status === 401 || rec.name === 'ApiError') {
      if (rec.status === 401) return step === 'mfa' ? 'mfa-expired' : 'verification-failed';
    }
  }
  return 'unknown';
}
