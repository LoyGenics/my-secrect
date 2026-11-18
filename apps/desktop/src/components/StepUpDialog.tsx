import { useState } from 'react';
import { useTranslation } from '../../../../packages/i18n/src/react';
import {
  ApiError,
  isStepUpRequired,
  type SecurityApiClient,
} from '../../../../packages/sdk/src/security';
import { serializeGetCredential, toRequestOptions } from '../utils/webauthn';

/**
 * StepUpDialog — fresh verification before a sensitive action.
 *
 * Two modes:
 *   - local (default): offers the master passphrase, TOTP and passkey.
 *     Used for LOCAL sensitive actions (export, change passphrase, wipe),
 *     where the passphrase check is enough.
 *   - serverOnly: offers ONLY passkey and TOTP. Server-side step-up
 *     (passkey add/remove, MFA disable, session revocation, account
 *     deletion, ...) is verified BY THE SERVER; the master passphrase is
 *     checked locally and never reaches the server, so it can never
 *     satisfy it. Offering it would only produce a dialog that "succeeds"
 *     and a server that still answers 403.
 *
 * Offered methods, in order:
 *   (i)   re-enter the master passphrase (always available while the
 *         vault is unlocked; verified with verifyPassphrase, which
 *         never stores the passphrase and never locks the vault on a
 *         wrong guess — see vault.ts). The passphrase is cleared from
 *         state as soon as verification succeeds or the dialog closes.
 *   (ii)  TOTP code via POST /v1/auth/step-up/totp — only when a
 *         server is configured (security != null).
 *   (iii) passkey via POST /v1/auth/step-up/passkey (after authenticate
 *         options) — only when a server is configured and this build
 *         offers WebAuthn; otherwise an honest unavailable note.
 *   (iv)  a code emailed to the account (POST /v1/auth/step-up/email/request
 *         then /step-up/email) — serverOnly and `allowEmail` only: the
 *         caller offers it while the account has no passkey and no MFA
 *         (its only login factor is the email), which is also how such an
 *         account adds its first passkey. The server refuses it otherwise.
 *
 * A step-up verification is valid for 10 minutes (STEP_UP_WINDOW_MS in
 * the SDK); the caller (App) owns the window and only opens this dialog
 * when it has expired. A 403 `step_up_required` from the server keeps
 * the dialog open with stepUpExpired so the user can re-try; any other
 * failure shows stepUpFailed. Cancelling runs onCancel and the pending
 * action never runs.
 *
 * NOTE on the one hardcoded string: the exact 65-key `security`
 * dictionary has no slot for a WebAuthn-unavailable note, so that one
 * explanatory clause is plain English here (the rest of the desktop
 * app hardcodes its strings too). Everything else uses the dictionary.
 */

export type StepUpMethod = 'passphrase' | 'totp' | 'passkey' | 'email';

export interface StepUpDialogProps {
  open: boolean;
  /** Null when no API base URL is configured: TOTP / passkey are hidden. */
  security: SecurityApiClient | null;
  /** Required unless serverOnly. */
  verifyPassphrase?: (passphrase: string) => Promise<boolean>;
  /** Only passkey / TOTP (server-verified); no passphrase option. */
  serverOnly?: boolean;
  /** Offer the emailed-code method (serverOnly): the account has no passkey and no MFA. */
  allowEmail?: boolean;
  /** 'export' shows the export-specific reason line; otherwise the generic body. */
  reason?: 'export';
  onVerified: (method: StepUpMethod) => void;
  onCancel: () => void;
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

export default function StepUpDialog({
  open,
  security,
  verifyPassphrase,
  serverOnly = false,
  allowEmail = false,
  reason,
  onVerified,
  onCancel,
}: StepUpDialogProps) {
  const { dict } = useTranslation();
  const s = dict.security;
  const x = dict.securityActions;
  const si = dict.signin;
  const [chosen, setChosen] = useState<StepUpMethod | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const emailOffered = serverOnly && allowEmail && security !== null;
  // No explicit pick yet: an email-only account starts on the email code.
  const method: StepUpMethod = chosen === 'email' && !emailOffered ? 'passkey'
    : chosen ?? (serverOnly ? (emailOffered ? 'email' : 'passkey') : 'passphrase');
  const setMethod = (m: StepUpMethod) => setChosen(m);

  const close = () => {
    setPassphrase('');
    setTotpCode('');
    setEmailCode('');
    setEmailSent(false);
    setError('');
    setBusy(false);
    onCancel();
  };

  const fail = (err: unknown) => {
    if (isStepUpRequired(err)) setError(s.stepUpExpired);
    else if (err instanceof ApiError) setError(`${s.stepUpFailed} (HTTP ${err.status})`);
    else setError(s.stepUpFailed);
  };

  const verifyWithPassphrase = async () => {
    setError('');
    setBusy(true);
    try {
      if (!verifyPassphrase) throw new Error('no passphrase verifier');
      const ok = await verifyPassphrase(passphrase);
      setPassphrase('');
      if (ok) onVerified('passphrase');
      else setError(s.stepUpFailed);
    } catch {
      setError(s.stepUpFailed);
    } finally {
      setBusy(false);
    }
  };

  const verifyWithTotp = async () => {
    if (!security) return;
    setError('');
    setBusy(true);
    try {
      await security.stepUpTotp(totpCode.trim());
      setTotpCode('');
      onVerified('totp');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const sendEmailCode = async () => {
    if (!security) return;
    setError('');
    setBusy(true);
    try {
      await security.stepUpEmailRequest();
      setEmailSent(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verifyWithEmail = async () => {
    if (!security) return;
    setError('');
    setBusy(true);
    try {
      await security.stepUpEmail(emailCode.trim());
      setEmailCode('');
      setEmailSent(false);
      onVerified('email');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verifyWithPasskey = async () => {
    if (!security) return;
    if (!webAuthnAvailable()) return;
    setError('');
    setBusy(true);
    try {
      // Options for the signed-in account (no email to type or leak).
      const { request_options } = await security.stepUpPasskeyOptions();
      const cred = await navigator.credentials.get({
        publicKey: toRequestOptions(request_options),
      });
      if (!cred) throw new Error('no credential returned');
      await security.stepUpPasskey(serializeGetCredential(cred as PublicKeyCredential));
      onVerified('passkey');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const canUseServerMethods = security !== null;
  const webauthn = webAuthnAvailable();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
    >
      <div className="card w-full max-w-md p-5">
        <h2 id="step-up-title" className="text-base font-semibold">
          {s.stepUpTitle}
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          {serverOnly ? x.stepUpServerBody : reason === 'export' ? s.exportRequiresStepUp : s.stepUpBody}
        </p>

        <fieldset className="mt-4 space-y-2">
          <legend className="label" id="step-up-method-legend">
            {s.stepUp}
          </legend>
          {!serverOnly && (
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="radio"
                name="step-up-method"
                value="passphrase"
                checked={method === 'passphrase'}
                onChange={() => setMethod('passphrase')}
                className="accent-indigo-600"
                aria-label={s.stepUpPassphraseLabel}
              />
              {s.stepUpPassphrase}
            </label>
          )}
          {emailOffered && (
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="radio"
                name="step-up-method"
                value="email"
                checked={method === 'email'}
                onChange={() => setMethod('email')}
                className="accent-indigo-600"
                aria-label={si.stepUpEmailOption}
              />
              {si.stepUpEmailOption}
            </label>
          )}
          {canUseServerMethods && (
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="radio"
                name="step-up-method"
                value="totp"
                checked={method === 'totp'}
                onChange={() => setMethod('totp')}
                className="accent-indigo-600"
                aria-label={s.stepUpTotpLabel}
              />
              {s.stepUpTotpLabel}
            </label>
          )}
          {canUseServerMethods && (
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="radio"
                name="step-up-method"
                value="passkey"
                checked={method === 'passkey'}
                onChange={() => setMethod('passkey')}
                className="accent-indigo-600"
                aria-label={s.stepUpPasskeyLabel}
                disabled={!webauthn}
              />
              {s.stepUpPasskeyLabel}
            </label>
          )}
        </fieldset>

        {method === 'passphrase' && !serverOnly && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyWithPassphrase();
            }}
          >
            <div>
              <label className="label" htmlFor="step-up-passphrase">
                {s.stepUpPassphraseLabel}
              </label>
              <input
                id="step-up-passphrase"
                name="step-up-passphrase"
                type="password"
                className="input"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="current-password"
                aria-label={s.stepUpPassphraseLabel}
                autoFocus
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy || !passphrase}>
              {s.stepUp}
            </button>
          </form>
        )}

        {method === 'email' && emailOffered && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void (emailSent ? verifyWithEmail() : sendEmailCode());
            }}
          >
            {emailSent && (
              <div>
                <label className="label" htmlFor="step-up-email-code">
                  {si.emailCodeLabel}
                </label>
                <input
                  id="step-up-email-code"
                  name="step-up-email-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="input font-mono"
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  placeholder="123456"
                  aria-label={si.emailCodeLabel}
                  autoFocus
                />
                <p className="mt-1 text-xs text-zinc-500">{si.emailCodeHint}</p>
              </div>
            )}
            <button
              type="submit"
              className="btn-primary w-full"
              disabled={busy || (emailSent && emailCode.length !== 6)}
            >
              {emailSent ? s.stepUp : si.sendCodeButton}
            </button>
          </form>
        )}

        {method === 'totp' && canUseServerMethods && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyWithTotp();
            }}
          >
            <div>
              <label className="label" htmlFor="step-up-totp-code">
                {s.stepUpTotpLabel}
              </label>
              <input
                id="step-up-totp-code"
                name="step-up-totp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="input font-mono"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                placeholder="123456"
                aria-label={s.stepUpTotpLabel}
                autoFocus
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy || totpCode.length !== 6}>
              {s.stepUp}
            </button>
          </form>
        )}

        {method === 'passkey' && canUseServerMethods && (
          <div className="mt-4 space-y-3">
            {!webauthn ? (
              <p className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
                WebAuthn is not available in this browser or build, so a passkey cannot be used
                here.{serverOnly ? '' : ' Use your master passphrase instead.'}
              </p>
            ) : (
              <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void verifyWithPasskey()}>
                {s.stepUpPasskeyLabel}
              </button>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}
        <button type="button" className="btn-ghost mt-3 w-full" onClick={close} disabled={busy}>
          {s.cancel}
        </button>
      </div>
    </div>
  );
}
