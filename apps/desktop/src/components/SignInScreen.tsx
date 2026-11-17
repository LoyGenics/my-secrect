import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../packages/i18n/src/react';
import {
  ApiError,
  LS_ACCOUNT_EMAIL,
  isMfaRequiredResult,
  saveSessionToken,
  webTokenStore,
  type SecurityApiClient,
  type SignInResult,
} from '../../../../packages/sdk/src/security';
import {
  classifySignInError,
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
 *   create-account uses the same steps with kind 'registration'.
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
  const webauthn = webAuthnAvailable();

  const store = webTokenStore();

  const finishSignIn = async (email: string, token: string, expiresIn: number) => {
    await saveSessionToken(store, token, expiresIn);
    try { localStorage.setItem(LS_ACCOUNT_EMAIL, email); } catch { /* non-critical */ }
    setCode('');
    onSignedIn(email);
  };

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (!webauthn) {
      setMachine((prev) => signInFailed(prev, 'webauthn-unavailable'));
      return;
    }
    const mode: SignInMode = machine.mode;
    let st = startSignIn(machine, emailInput, mode);
    setMachine(st);
    if (st.error) return;
    const email = st.email;
    try {
      // Step 1: fresh single-use options (5 min). Never reused.
      const options =
        mode === 'create'
          ? await security.passkeyRegisterOptions(email)
          : await security.passkeyAuthenticateOptions(email);
      st = optionsReceived(st);
      setMachine(st);
      // Step 2: the browser ceremony (user presence + verification
      // are required server-side; the authenticator enforces them).
      let credential: unknown;
      if (mode === 'create') {
        const cred = await navigator.credentials.create({
          publicKey: toCreationOptions(options.creation_options),
        });
        if (!cred) throw new Error('no credential returned');
        credential = serializeCreateCredential(cred as PublicKeyCredential);
      } else {
        const cred = await navigator.credentials.get({
          publicKey: toRequestOptions(options.request_options),
        });
        if (!cred) throw new Error('no credential returned');
        credential = serializeGetCredential(cred as PublicKeyCredential);
      }
      // Step 3: verify. Either a session, or an MFA park.
      const res: SignInResult =
        mode === 'create'
          ? await security.passkeyRegisterVerify(email, credential)
          : await security.passkeyLoginVerify(email, credential);
      st = passkeyVerified(st, res);
      setMachine(st);
      if (st.step === 'signed-in' && !isMfaRequiredResult(res)) {
        await finishSignIn(email, res.token, res.expires_in);
      }
    } catch (err) {
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
  };

  const error = machine.error ? errorText(machine.error, s as unknown as Record<string, string>) : '';

  return (
    <div className="flex min-h-full items-center justify-center bg-[#0B0F14] p-6">
      <div className="card gradient-subtle w-full max-w-md p-6">
        <h1 className="text-xl font-semibold">{s.title}</h1>
        <p className="mt-1 text-sm text-zinc-400">{s.subtitle}</p>
        {sessionExpired && (
          <p role="alert" className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
            {s.sessionExpired}
          </p>
        )}
        {!webauthn && (
          <p role="alert" className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
            <strong>{s.passkeyNotAvailable}.</strong> {s.passkeyNotAvailableBody}
          </p>
        )}

        {machine.step !== 'mfa' && (
          <>
            <div className="mt-4 flex gap-2" role="tablist" aria-label="Sign-in mode">
              <button
                type="button"
                role="tab"
                aria-selected={machine.mode === 'login'}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm ${machine.mode === 'login' ? 'bg-indigo-600/25 text-indigo-200' : 'bg-zinc-900 text-zinc-400'}`}
                onClick={() => switchMode('login')}
              >
                {s.signIn}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={machine.mode === 'create'}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm ${machine.mode === 'create' ? 'bg-indigo-600/25 text-indigo-200' : 'bg-zinc-900 text-zinc-400'}`}
                onClick={() => switchMode('create')}
              >
                {s.createAccount}
              </button>
            </div>
            <form className="mt-4 space-y-3" onSubmit={(e) => void submitEmail()}>
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
              {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
              <button type="submit" className="btn-primary w-full" disabled={machine.busy || !webauthn || !emailInput.trim()}>
                {machine.mode === 'create' ? s.createAccountButton : s.signInButton}
              </button>
            </form>
          </>
        )}

        {machine.step === 'mfa' && (
          <form className="mt-4 space-y-3" onSubmit={(e) => void submitMfa()}>
            <h2 className="text-base font-semibold">{s.mfaTitle}</h2>
            <p className="text-sm text-zinc-400">{s.mfaBody}</p>
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
              <p className="mt-1 text-xs text-zinc-500">
                {useRecoveryCode ? s.recoveryCodeHint : s.mfaTotpHint}
              </p>
            </div>
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              className="btn-primary w-full"
              disabled={machine.busy || (useRecoveryCode ? code.trim().length < 9 : code.trim().length !== 6)}
            >
              {s.verifyCode}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-indigo-300 hover:text-indigo-200"
              onClick={() => { setUseRecoveryCode((v) => !v); setCode(''); }}
            >
              {useRecoveryCode ? s.useTotpCode : s.useRecoveryCode}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-zinc-400 hover:text-zinc-200"
              onClick={() => setMachine(initialSignInState(machine.mode))}
            >
              {s.back}
            </button>
          </form>
        )}

        <button type="button" className="mt-4 w-full text-center text-sm text-zinc-400 hover:text-zinc-200" onClick={onContinueLocalOnly}>
          {s.continueLocalOnly}
        </button>
        <p className="mt-4 text-xs text-zinc-500">
          Passkey-only sign-in — there is no password login. The server never sees your vault keys or contents.
        </p>
      </div>
    </div>
  );
}
