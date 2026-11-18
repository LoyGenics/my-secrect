import { useRef, useState, type FormEvent } from 'react';
import { Art, Icon, brandMark, illustrations } from '../theme';
import './signin.css';
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
  emailSignedIn,
  initialSignInState,
  mfaVerified,
  optionsReceived,
  passkeyVerified,
  signInFailed,
  startEmailSignIn,
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
import { serializeGetCredential, toRequestOptions } from '../utils/webauthn';

/**
 * SignInScreen — account sign-in by email code, or by passkey once the
 * account has one. Rendered by App BEFORE the vault (onboarding / lock)
 * whenever an API base URL is configured and no valid session token is
 * stored.
 *
 * There is no password login. A passkey is an optional upgrade added
 * later in the Security Center; it is never required to sign up. Flow
 * (see packages/sdk/src/signin.ts — the state machine this screen drives):
 *   email -> 6-digit code from the email -> signed-in (creates the account
 *     on first use). The code is traded for a single-use ticket kept in
 *     memory only, then spent for a session together with this browser's
 *     device proof signed over the ticket. A bad device proof retries with
 *     the same ticket; an expired ticket restarts from the email step. The
 *     screen shows the same "check your email" step whether or not the
 *     address already has an account (an account WITH a passkey gets a
 *     notice, not a code — it signs in with the passkey).
 *   email -> passkey ceremony -> signed-in
 *   either path -> MFA step (TOTP code or recovery code) -> signed-in
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
 * carries a device proof signed over that ceremony's challenge (the email
 * path signs the ticket instead) with
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

  /** Passkey sign-in (login tab, primary button). */
  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (machine.mode === 'create') {
      await startEmailCode();
      return;
    }
    if (!webauthn) {
      setMachine((prev) => signInFailed(prev, 'webauthn-unavailable'));
      return;
    }
    const st = startSignIn(machine, emailInput, 'login');
    setMachine(st);
    if (st.error) return;
    await runLogin(st);
  };

  /** Email-code path: sign up (create tab) or sign in without a passkey. */
  const startEmailCode = async () => {
    const st = startEmailSignIn(machine, emailInput, machine.mode);
    setMachine(st);
    if (st.error) return;
    await requestCode(st);
  };

  /** Email-code steps 2 + 3: trade the emailed code for a ticket (skipped
   *  when a ticket from a failed attempt is still held), then spend it for a
   *  session together with this browser's device proof over the ticket. */
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
    }
    const device = await prepareDevice(st.email, currentTicket);
    try {
      const res = await security.emailSessionVerify(st.email, currentTicket, device?.proof);
      st = emailSignedIn(st, res);
      setMachine(st);
      if (isMfaRequiredResult(res)) {
        // The ticket is spent; the device is confirmed once MFA succeeds.
        pendingDevice.current = device;
        setTicket(null);
      } else if (st.step === 'signed-in') {
        setTicket(null);
        await device?.confirm(res.device_id);
        await finishSignIn(st.email, res.token, res.expires_in);
      }
    } catch (err) {
      if (isDeviceVerificationFailed(err)) {
        // Rolled back server-side; the ticket is still usable, so the next
        // attempt (no new code) enrols a fresh key.
        await device?.reject();
        setMachine((prev) => signInFailed(prev, 'device-rejected'));
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        // Ticket expired or spent: a new code is needed.
        setTicket(null);
        setMachine(signInFailed(st, 'signup-expired'));
        return;
      }
      setMachine((prev) => signInFailed(prev, classifySignInError(err, 'email-code')));
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
    const st = startEmailSignIn(machine, machine.email, machine.mode);
    setMachine(st);
    if (!st.error) void requestCode(st);
  };

  const onCodeStep = machine.step === 'email-code';

  const error = machine.error ? errorText(machine.error, s as unknown as Record<string, string>) : '';
  const busyIcon = <Icon name="spinner" size="lg" />;
  const rise = (i: number) => ({ '--i': i }) as React.CSSProperties;

  return (
    <div className="si">
      <aside className="si-aside">
        <div className="si-brand">
          <img src={brandMark.src} alt="" width={36} height={36} />
          <span>My Secret</span>
        </div>
        <div className="si-hero">
          <span className="si-hero__shadow" aria-hidden="true" />
          <Art src={illustrations.splash} size={340} eager className="si-hero__art" />
        </div>
        <h2>{s.asideHeadline}</h2>
        <ul className="si-trust">
          <li><span className="si-trust__icon"><Icon name="lock" size="md" /></span>{s.trustEncrypted}</li>
          <li><span className="si-trust__icon"><Icon name="server" size="md" /></span>{s.trustCiphertext}</li>
          <li><span className="si-trust__icon"><Icon name="passkey" size="md" /></span>{s.trustNoPassword}</li>
        </ul>
      </aside>

      <main className="si-main">
        <div className="si-card">
          <div className="si-compact">
            <Art src={illustrations.deviceHero} size={76} eager className="si-compact__art" />
            <span className="si-brand">My Secret</span>
          </div>
          <h1>{s.title}</h1>
          <p className="si-sub">{s.subtitle}</p>

          {sessionExpired && <p role="alert" className="si-note" style={{ marginTop: 14 }}>{s.sessionExpired}</p>}
          {!webauthn && machine.step !== 'mfa' && !onCodeStep && (
            <p role="alert" className="si-note" style={{ marginTop: 14 }}>
              <strong>{s.passkeyNotAvailable}.</strong> {s.passkeyNotAvailableBody}
            </p>
          )}

          {onCodeStep && (
            <form key="code" className="si-step" onSubmit={(e) => void submitEmailCode(e)}>
              <h2 className="si-h2" style={rise(0)}>{s.emailCodeTitle}</h2>
              <p className="si-sub" style={{ ...rise(1), margin: 0 }}>{s.emailCodeBody}</p>
              <span className="si-email-chip" style={rise(2)}><Icon name="mail" size="md" /><span>{machine.email}</span></span>
              {!ticket && (
                <div className="si-field" style={rise(3)}>
                  <label className="si-label" htmlFor="signin-email-code">{s.emailCodeLabel}</label>
                  <OtpField id="signin-email-code" value={emailCode} onChange={setEmailCode} label={s.emailCodeLabel} />
                  <p className="si-hint">{s.emailCodeHint}</p>
                </div>
              )}
              {error && <p role="alert" className="si-alert">{error}</p>}
              <button type="submit" className="si-btn si-btn--primary" style={rise(4)} disabled={machine.busy || (!ticket && emailCode.length !== 6)}>
                {machine.busy ? busyIcon : <Icon name="enter" size="lg" />}
                {machine.mode === 'create' ? s.createAccountButton : s.signIn}
              </button>
              <button type="button" className="si-link si-link--brand" style={rise(5)} disabled={machine.busy} onClick={resendCode}>{s.resendCode}</button>
              <button type="button" className="si-link" style={rise(6)} onClick={() => switchMode(machine.mode)}>{s.back}</button>
            </form>
          )}

          {machine.step !== 'mfa' && !onCodeStep && (
            <>
              <div className="si-tabs" data-mode={machine.mode} role="tablist" aria-label="Sign-in mode">
                <span className="si-tabs__thumb" aria-hidden="true" />
                <button type="button" role="tab" aria-selected={machine.mode === 'login'} className="si-tab" onClick={() => switchMode('login')}>{s.signIn}</button>
                <button type="button" role="tab" aria-selected={machine.mode === 'create'} className="si-tab" onClick={() => switchMode('create')}>{s.createAccount}</button>
              </div>
              <form key={machine.mode} className="si-step" onSubmit={(e) => void submitEmail(e)}>
                <div className="si-field" style={rise(0)}>
                  <label className="si-label" htmlFor="signin-email">{s.emailLabel}</label>
                  <div className="si-input">
                    <Icon name="mail" size="lg" />
                    <input
                      id="signin-email"
                      name="signin-email"
                      type="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder={s.emailPlaceholder}
                      autoComplete="email"
                      aria-label={s.emailLabel}
                      autoFocus
                    />
                  </div>
                </div>
                {error && <p role="alert" className="si-alert">{error}</p>}
                {machine.mode === 'create' ? (
                  <button type="submit" className="si-btn si-btn--primary" style={rise(1)} disabled={machine.busy || !emailInput.trim()}>
                    {machine.busy ? busyIcon : <Icon name="mail" size="lg" />}
                    {s.sendCodeButton}
                  </button>
                ) : (
                  <>
                    <button type="submit" className="si-btn si-btn--primary" style={rise(1)} disabled={machine.busy || !webauthn || !emailInput.trim()}>
                      {machine.busy ? busyIcon : <Icon name="passkey" size="lg" />}
                      {s.signInButton}
                    </button>
                    <button type="button" className="si-btn" style={rise(2)} disabled={machine.busy || !emailInput.trim()} onClick={() => void startEmailCode()}>
                      <Icon name="mail" size="lg" />
                      {s.sendCodeButton}
                    </button>
                  </>
                )}
              </form>
            </>
          )}

          {machine.step === 'mfa' && (
            <form key="mfa" className="si-step" onSubmit={(e) => void submitMfa(e)}>
              <h2 className="si-h2" style={rise(0)}>{s.mfaTitle}</h2>
              <p className="si-sub" style={{ ...rise(1), margin: 0 }}>{s.mfaBody}</p>
              <div className="si-field" style={rise(2)}>
                <label className="si-label" htmlFor="signin-mfa-code">{useRecoveryCode ? s.recoveryCodeLabel : s.mfaCodeLabel}</label>
                <div className="si-input">
                  <Icon name="security" size="lg" />
                  <input
                    id="signin-mfa-code"
                    name="signin-mfa-code"
                    type="text"
                    inputMode={useRecoveryCode ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.12em' }}
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
                </div>
                <p className="si-hint">{useRecoveryCode ? s.recoveryCodeHint : s.mfaTotpHint}</p>
              </div>
              {error && <p role="alert" className="si-alert">{error}</p>}
              <button type="submit" className="si-btn si-btn--primary" style={rise(3)} disabled={machine.busy || (useRecoveryCode ? code.trim().length < 9 : code.trim().length !== 6)}>
                {machine.busy ? busyIcon : <Icon name="check" size="lg" />}
                {s.verifyCode}
              </button>
              <button type="button" className="si-link si-link--brand" style={rise(4)} onClick={() => { setUseRecoveryCode((v) => !v); setCode(''); }}>
                {useRecoveryCode ? s.useTotpCode : s.useRecoveryCode}
              </button>
              <button type="button" className="si-link" style={rise(5)} onClick={() => setMachine(initialSignInState(machine.mode))}>{s.back}</button>
            </form>
          )}

          <p className="si-foot">
            <button type="button" className="si-link" onClick={onContinueLocalOnly}>{s.continueLocalOnly}</button>
          </p>
          <p className="si-fine">{s.footerNote}</p>
        </div>
      </main>
    </div>
  );
}

/** Six-digit code: one real input (autofill, paste, screen readers) drawn as six boxes. */
function OtpField({ id, value, onChange, label }: { id: string; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="si-otp">
      <input
        id={id}
        name={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
        aria-label={label}
        autoFocus
      />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="si-otp__box" aria-hidden="true" data-filled={i < value.length} data-active={i === Math.min(value.length, 5)}>
          {value[i] ? <span key={value[i] + i} className="si-otp__digit">{value[i]}</span> : null}
        </span>
      ))}
    </div>
  );
}
