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

export type StepUpMethod = 'passphrase' | 'totp' | 'passkey';

export interface StepUpDialogProps {
  open: boolean;
  /** Null when no API base URL is configured: TOTP / passkey are hidden. */
  security: SecurityApiClient | null;
  verifyPassphrase: (passphrase: string) => Promise<boolean>;
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
  reason,
  onVerified,
  onCancel,
}: StepUpDialogProps) {
  const { dict } = useTranslation();
  const s = dict.security;
  const [method, setMethod] = useState<StepUpMethod>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const close = () => {
    setPassphrase('');
    setTotpCode('');
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

  const verifyWithPasskey = async () => {
    if (!security) return;
    if (!webAuthnAvailable()) return;
    setError('');
    setBusy(true);
    try {
      const { request_options } = await security.passkeyAuthenticateOptions(email.trim());
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
          {reason === 'export' ? s.exportRequiresStepUp : s.stepUpBody}
        </p>

        <fieldset className="mt-4 space-y-2">
          <legend className="label" id="step-up-method-legend">
            {s.stepUp}
          </legend>
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

        {method === 'passphrase' && (
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
                here. Use your master passphrase instead.
              </p>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void verifyWithPasskey();
                }}
              >
                <div>
                  <label className="label" htmlFor="step-up-passkey-email">
                    Account email
                  </label>
                  <input
                    id="step-up-passkey-email"
                    name="step-up-passkey-email"
                    type="email"
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    aria-label="Account email"
                    autoFocus
                  />
                </div>
                <button type="submit" className="btn-primary w-full" disabled={busy || !email.trim()}>
                  {s.stepUpPasskeyLabel}
                </button>
              </form>
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
