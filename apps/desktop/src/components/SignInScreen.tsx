import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../packages/i18n/src/react';
import {
  ApiError,
  LS_ACCOUNT_EMAIL,
  isDeviceApprovalRequired,
  isDeviceVerificationFailed,
  isMfaRequiredResult,
  saveSessionToken,
  webTokenStore,
  type SecurityApiClient,
  type SignInResult,
} from '../../../../packages/sdk/src/security';
import {
  classifySignInError,
  emailCodeRequestFailed,
  emailCodeSent,
  emailCodeVerified,
  initialSignInState,
  mfaVerified,
  optionsReceived,
  passkeyVerified,
  signInFailed,
  startSignIn,
  type SignInErrorKind,
  type SignInMode,
  type SignInState,
} from '../../../../packages/sdk/src/signin';
import {
  deviceKeyScope,
  prepareSignInDeviceProof,
  type PreparedDeviceProof,
} from '../../../../packages/sdk/src/device-key-store';
import {
  serializeCreateCredential,
  serializeGetCredential,
  toCreationOptions,
  toRequestOptions,
} from '../utils/webauthn';

/**
 * SignInScreen — account sign-in, passkey-first. Rendered by App
 * BEFORE the vault (onboarding / lock) whenever an API base URL is
 * configured and no valid session token is stored.
 *
 * The API is passkey-only: there is no password login endpoint, so
 * none is offered here. Flow (see packages/sdk/src/signin.ts — the
 * state machine this screen drives):
 *   email -> passkey ceremony -> signed-in
 *   email -> passkey ceremony -> MFA step (TOTP code or recovery
 *     code) -> signed-in
 *   create-account: email -> 6-digit code from the email -> passkey
 *     ceremony (kind 'registration') -> signed-in. The code is traded
 *     for a single-use registration ticket kept in memory only; a
 *     failed ceremony retries with the same ticket, an expired ticket
 *     restarts from the email step. The screen shows the same "check
 *     your email" step whether or not the address already has an
 *     account (the server mails that owner a notice, not a code).
 *
 * Account sign-in is SEPARATE from vault unlock: a successful
 * sign-in stores only the opaque Bearer session token (via the
 * SDK's saveSessionToken, key LS_API_TOKEN) and calls onSignedIn.
 * The vault still needs the master passphrase afterwards, as a
 * separate step, and the passphrase is never stored with the token
 * and never sent to the server.
 *
 * Honest states: invalid email, WebAuthn unavailable (no fake
 * flow — sign-in simply cannot start here), user-cancelled
 * ceremony, generic verification failure (the server returns one
 * generic 401 and never says which check failed), expired
 * challenge / MFA token (both single-use — restart from email),
 * offline. "Continue without signing in" keeps the local vault
 * usable when the server is unreachable or the user wants
 * local-only: account features then stay signed out.
 *
 * Device binding (specs/device-identity.md): every passkey verify
 * carries a device proof signed over that ceremony's challenge with
 * this browser's Ed25519 device key (non-extractable WebCrypto key in
 * IndexedDB, libsodium fallback — packages/sdk/src/device-key-store.ts):
 * an enrol proof the first time for this (server, account), a bind proof
 * afterwards. If the server rejects the device (e.g. it was revoked),
 * the local key is dropped and the sign-in is retried ONCE with a new
 * enrolment (one more passkey prompt). If that passkey enrolled the
 * revoked device, the server refuses the new enrolment too (403
 * device_approval_required) and the screen says how to re-approve it.
 * If the key store is unavailable the sign-in still works, with an
 * unbound session.
 *
 * Nothing here is logged: no token, no email in logs, no TOTP /
 * recovery code retained after its request settles.
 */

export interface SignInScreenProps {
  security: SecurityApiClient;
  /** True when the previous session expired (401) — shown as a note. */
  sessionExpired?: boolean;
  onSignedIn: (email: string) => void;
  onContinueLocalOnly: () => void;
}

function webAuthnAvailable(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function'
    );
  } catch {
    return false;
  }
}

function errorText(kind: SignInErrorKind, s: Record<string, string>): string {
  switch (kind) {
    case 'invalid-email': return s.invalidEmail;
    case 'webauthn-unavailable': return s.webauthnUnavailable;
    case 'passkey-cancelled': return s.passkeyCancelled;
    case 'verification-failed': return s.verificationFailed;
    case 'challenge-expired': return s.challengeExpired;
    case 'mfa-expired': return s.mfaExpired;
    case 'email-code-failed': return s.emailCodeFailed;
    case 'email-unavailable': return s.emailUnavailable;
    case 'signup-expired': return s.signupExpired;
    case 'device-rejected': return s.deviceRejected;
    case 'device-approval-required': return s.deviceApprovalRequired;
    case 'offline': return s.offline;
    default: return s.unknownError;
  }
}

export default function SignInScreen({ security, sessionExpired, onSignedIn, onContinueLocalOnly }: SignInScreenProps) {
  const { dict } = useTranslation();
  const s = dict.signin;
  const [machine, setMachine] = useState<SignInState>(() => initialSignInState('login'));
  const [emailInput, setEmailInput] = useState('');
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  // Single-use registration ticket from POST /v1/auth/email/verify.
  // Memory only (never stored, never logged); dropped on success, on
  // restart, and when the server answers that it is spent or expired.
  const [ticket, setTicket] = useState<string | null>(null);
  // Device proof of a login parked at MFA: confirmed once MFA succeeds.
  const pendingDevice = useRef<PreparedDeviceProof | null>(null);
  const webauthn = webAuthnAvailable();

  const store = webTokenStore();

  const finishSignIn = async (email: string, token: string, expiresIn: number) => {
    await saveSessionToken(store, token, expiresIn);
    try { localStorage.setItem(LS_ACCOUNT_EMAIL, email); } catch { /* non-critical */ }
    setCode('');
    onSignedIn(email);
  };

  /** This browser's device proof over `challenge`, or null when the key
   *  store is unavailable (the session is then simply unbound). */
  const prepareDevice = async (email: string, challenge: unknown): Promise<PreparedDeviceProof | null> => {
    if (typeof challenge !== 'string' || !challenge) return null;
    try {
      const platform = typeof navigator !== 'undefined' ? navigator.platform || 'web' : 'web';
      return await prepareSignInDeviceProof(deviceKeyScope(security.baseUrl, email), challenge, platform);
    } catch {
      return null;
    }
  };

  /** Create-account step 1: ask the server to email a code. */
  const requestCode = async (st: SignInState) => {
    setTicket(null);
    setEmailCode('');
    try {
      await security.requestEmailCode(st.email);
      setMachine(emailCodeSent(st));
    } catch (err) {
      setMachine(emailCodeRequestFailed(st, classifySignInError(err, 'email-code')));
    }
  };

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (!webauthn) {
      setMachine((prev) => signInFailed(prev, 'webauthn-unavailable'));
      return;
    }
    const mode: SignInMode = machine.mode;
    const st = startSignIn(machine, emailInput, mode);
    setMachine(st);
    if (st.error) return;
    if (mode === 'create') {
      await requestCode(st);
      return;
    }
    await runLogin(st);
  };

  /** Create-account steps 2 + 3: trade the emailed code for a ticket
   *  (skipped when a ticket from a failed ceremony is still held), then
   *  run the registration ceremony with it. */
  const submitEmailCode = async (e: FormEvent) => {
    e.preventDefault();
    let st: SignInState = { ...machine, busy: true, error: null };
    setMachine(st);
    let currentTicket = ticket;
    if (!currentTicket) {
      try {
        currentTicket = (await security.verifyEmailCode(st.email, emailCode.trim())).registration_ticket;
        setTicket(currentTicket);
      } catch (err) {
        setMachine(signInFailed(st, classifySignInError(err, 'email-code')));
        return;
      } finally {
        setEmailCode('');
      }
      st = emailCodeVerified(st);
      setMachine(st);
    }
    try {
      let registerOptions;
      try {
        registerOptions = await security.passkeyRegisterOptions(st.email, currentTicket);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Ticket expired or spent: a new code is needed.
          setTicket(null);
          setMachine(signInFailed(st, 'signup-expired'));
          return;
        }
        throw err;
      }
      st = optionsReceived(st);
      setMachine(st);
      const cred = await navigator.credentials.create({
        publicKey: toCreationOptions(registerOptions.creation_options),
      });
      if (!cred) throw new Error('no credential returned');
      const device = await prepareDevice(st.email, (registerOptions.creation_options as { challenge?: unknown })?.challenge);
      let res;
      try {
        res = await security.passkeyRegisterVerify(st.email, serializeCreateCredential(cred as PublicKeyCredential), device?.proof);
      } catch (err) {
        // The server rolled the sign-up back; drop the key so the next
        // attempt (same ticket) enrols a fresh one.
        if (isDeviceVerificationFailed(err)) await device?.reject();
        throw err;
      }
      await device?.confirm(res.device_id);
      st = passkeyVerified(st, res);
      setMachine(st);
      if (st.step === 'signed-in') {
        setTicket(null);
        await finishSignIn(st.email, res.token, res.expires_in);
      }
    } catch (err) {
      // A 401 from verify is generic by design. The ticket is kept: the
      // user can retry the ceremony without a new code.
      const kind = isDeviceVerificationFailed(err) ? 'device-rejected' : classifySignInError(err, st.step);
      setMachine((prev) => signInFailed(prev, err instanceof ApiError && err.status === 401 && kind !== 'device-rejected' ? 'verification-failed' : kind));
    }
  };

  /** Sign-in: fresh options -> navigator.credentials.get -> verify.
   *  `retried`: the one automatic retry after a rejected device key. */
  const runLogin = async (start: SignInState, retried = false) => {
    let st = start;
    const email = st.email;
    try {
      // Step 1: fresh single-use options (5 min). Never reused.
      const authenticateOptions = await security.passkeyAuthenticateOptions(email);
      st = optionsReceived(st);
      setMachine(st);
      // Step 2: the browser ceremony (user presence + verification
      // are required server-side; the authenticator enforces them).
      const cred = await navigator.credentials.get({
        publicKey: toRequestOptions(authenticateOptions.request_options),
      });
      if (!cred) throw new Error('no credential returned');
      const credential = serializeGetCredential(cred as PublicKeyCredential);
      // Step 3: verify (with this browser's device proof over the same
      // challenge). Either a session, or an MFA park.
      const device = await prepareDevice(email, (authenticateOptions.request_options as { challenge?: unknown })?.challenge);
      let res: SignInResult;
      try {
        res = await security.passkeyLoginVerify(email, credential, device?.proof);
      } catch (err) {
        if (isDeviceVerificationFailed(err) && device) {
          // Revoked or unknown device: forget the key and retry once,
          // which enrols a fresh one (another passkey prompt).
          await device.reject();
          if (!retried) {
            await runLogin(start, true);
            return;
          }
        }
        throw err;
      }
      st = passkeyVerified(st, res);
      setMachine(st);
      if (isMfaRequiredResult(res)) {
        pendingDevice.current = device;
      } else if (st.step === 'signed-in') {
        await device?.confirm(res.device_id);
        await finishSignIn(email, res.token, res.expires_in);
      }
    } catch (err) {
      if (isDeviceVerificationFailed(err)) {
        setMachine((prev) => signInFailed(prev, 'device-rejected'));
        return;
      }
      // The passkey enrolled a device that was revoked: it cannot set up
      // this browser until it is re-approved from a still-trusted device
      // (specs/device-identity.md §6.3). No retry helps.
      if (isDeviceApprovalRequired(err)) {
        setMachine((prev) => signInFailed(prev, 'device-approval-required'));
        return;
      }
      const kind = classifySignInError(err, st.step);
      // A 401 from verify is generic by design — never leak which
      // check failed. A challenge that expired mid-ceremony sends
      // the user back to the email step for fresh options.
      if (err instanceof ApiError && err.status === 401) {
        setMachine((prev) => signInFailed(prev, kind === 'challenge-expired' ? 'challenge-expired' : 'verification-failed'));
      } else {
        setMachine((prev) => signInFailed(prev, kind));
      }
    }
  };

  const submitMfa = async (e: FormEvent) => {
    e.preventDefault();
    const token = machine.mfaToken;
    if (!token) {
      setMachine((prev) => signInFailed(prev, 'mfa-expired'));
      return;
    }
    const value = useRecoveryCode ? code.trim().toUpperCase() : code.trim();
    if (!value) return;
    setMachine((prev) => ({ ...prev, busy: true, error: null }));
    try {
      // The mfa_token is single-use: consumed server-side whether
      // this code is right or wrong. A failure here therefore ends
      // this login attempt — the screen restarts from email.
      const res = await security.mfaVerify(token, value);
      const st = mfaVerified(machine, res);
      setMachine(st);
      if (st.step === 'signed-in') {
        await pendingDevice.current?.confirm(res.device_id);
        pendingDevice.current = null;
        await finishSignIn(machine.email, res.token, res.expires_in);
      }
    } catch (err) {
      const kind = classifySignInError(err, 'mfa');
      setMachine((prev) => signInFailed(prev, kind === 'verification-failed' ? 'mfa-expired' : kind));
    } finally {
      setCode('');
    }
  };

  const switchMode = (mode: SignInMode) => {
    setMachine(initialSignInState(mode));
    setCode('');
    setUseRecoveryCode(false);
    setEmailCode('');
    setTicket(null);
  };

  const resendCode = () => {
    const st = startSignIn(machine, machine.email, 'create');
    setMachine(st);
    if (!st.error) void requestCode(st);
  };

  const onCodeStep = machine.mode === 'create' && (machine.step === 'email-code' || machine.step === 'passkey');

  const error = machine.error ? errorText(machine.error, s as unknown as Record<string, string>) : '';

  return (
    <div className="flex min-h-full items-center justify-center bg-[#0B0F14] p-6">
      <div className="card w-full max-w-md p-6">
        <h1 className="text-xl font-semibold">{s.title}</h1>
        <p className="mt-1 text-sm text-ms-muted">{s.subtitle}</p>
        {sessionExpired && (
          <p role="alert" className="mt-3 rounded-lg border border-ms-warn-line bg-ms-warn-bg px-3 py-2 text-sm text-ms-warn-text">
            {s.sessionExpired}
          </p>
        )}
        {!webauthn && (
          <p role="alert" className="mt-3 rounded-lg border border-ms-warn-line bg-ms-warn-bg px-3 py-2 text-sm text-ms-warn-text">
            <strong>{s.passkeyNotAvailable}.</strong> {s.passkeyNotAvailableBody}
          </p>
        )}

        {onCodeStep && (
          <form className="mt-4 space-y-3" onSubmit={(e) => void submitEmailCode(e)}>
            <h2 className="text-base font-semibold">{s.emailCodeTitle}</h2>
            <p className="text-sm text-ms-muted">{s.emailCodeBody}</p>
            <p className="truncate text-sm font-semibold text-ms-text">{machine.email}</p>
            {!ticket && (
              <div>
                <label className="label" htmlFor="signin-email-code">{s.emailCodeLabel}</label>
                <input
                  id="signin-email-code"
                  name="signin-email-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="input font-mono"
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  placeholder="123456"
                  aria-label={s.emailCodeLabel}
                  autoFocus
                />
                <p className="mt-1 text-xs text-ms-muted">{s.emailCodeHint}</p>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-ms-danger-text">{error}</p>}
            <button
              type="submit"
              className="btn-primary w-full"
              disabled={machine.busy || (!ticket && emailCode.length !== 6)}
            >
              {s.createAccountButton}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-ms-link hover:text-ms-text"
              disabled={machine.busy}
              onClick={resendCode}
            >
              {s.resendCode}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-ms-muted hover:text-ms-text"
              onClick={() => switchMode('create')}
            >
              {s.back}
            </button>
          </form>
        )}

        {machine.step !== 'mfa' && !onCodeStep && (
          <>
            <div className="mt-4 flex gap-2" role="tablist" aria-label="Sign-in mode">
              <button
                type="button"
                role="tab"
                aria-selected={machine.mode === 'login'}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm ${machine.mode === 'login' ? 'bg-ms-brand-bg text-ms-text' : 'bg-ms-surface2 text-ms-muted'}`}
                onClick={() => switchMode('login')}
              >
                {s.signIn}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={machine.mode === 'create'}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm ${machine.mode === 'create' ? 'bg-ms-brand-bg text-ms-text' : 'bg-ms-surface2 text-ms-muted'}`}
                onClick={() => switchMode('create')}
              >
                {s.createAccount}
              </button>
            </div>
            <form className="mt-4 space-y-3" onSubmit={(e) => void submitEmail(e)}>
              <div>
                <label className="label" htmlFor="signin-email">{s.emailLabel}</label>
                <input
                  id="signin-email"
                  name="signin-email"
                  type="email"
                  className="input"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder={s.emailPlaceholder}
                  autoComplete="email"
                  aria-label={s.emailLabel}
                  autoFocus
                />
              </div>
              {error && <p role="alert" className="text-sm text-ms-danger-text">{error}</p>}
              <button type="submit" className="btn-primary w-full" disabled={machine.busy || !webauthn || !emailInput.trim()}>
                {machine.mode === 'create' ? s.sendCodeButton : s.signInButton}
              </button>
            </form>
          </>
        )}

        {machine.step === 'mfa' && (
          <form className="mt-4 space-y-3" onSubmit={(e) => void submitMfa(e)}>
            <h2 className="text-base font-semibold">{s.mfaTitle}</h2>
            <p className="text-sm text-ms-muted">{s.mfaBody}</p>
            <div>
              <label className="label" htmlFor="signin-mfa-code">
                {useRecoveryCode ? s.recoveryCodeLabel : s.mfaCodeLabel}
              </label>
              <input
                id="signin-mfa-code"
                name="signin-mfa-code"
                type="text"
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                className="input font-mono"
                value={code}
                onChange={(e) =>
                  setCode(
                    useRecoveryCode
                      ? e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9)
                      : e.target.value.replace(/[^0-9]/g, '').slice(0, 6),
                  )
                }
                placeholder={useRecoveryCode ? 'XXXX-XXXX' : '123456'}
                aria-label={useRecoveryCode ? s.recoveryCodeLabel : s.mfaCodeLabel}
                autoFocus
              />
              <p className="mt-1 text-xs text-ms-muted">
                {useRecoveryCode ? s.recoveryCodeHint : s.mfaTotpHint}
              </p>
            </div>
            {error && <p role="alert" className="text-sm text-ms-danger-text">{error}</p>}
            <button
              type="submit"
              className="btn-primary w-full"
              disabled={machine.busy || (useRecoveryCode ? code.trim().length < 9 : code.trim().length !== 6)}
            >
              {s.verifyCode}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-ms-link hover:text-ms-text"
              onClick={() => { setUseRecoveryCode((v) => !v); setCode(''); }}
            >
              {useRecoveryCode ? s.useTotpCode : s.useRecoveryCode}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-ms-muted hover:text-ms-text"
              onClick={() => setMachine(initialSignInState(machine.mode))}
            >
              {s.back}
            </button>
          </form>
        )}

        <button type="button" className="mt-4 w-full text-center text-sm text-ms-muted hover:text-ms-text" onClick={onContinueLocalOnly}>
          {s.continueLocalOnly}
        </button>
        <p className="mt-4 text-xs text-ms-muted">
          Passkey-only sign-in — there is no password login. The server never sees your vault keys or contents.
        </p>
      </div>
    </div>
  );
}
