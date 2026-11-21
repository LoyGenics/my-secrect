import { useEffect, useState, type ReactNode } from 'react';
import type { AccountStatus, ExtRequest, ExtResponse } from '../lib/messages';
import type { AuthErrorCode } from '../lib/account-core';
import { format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Msg } from './parts';

/**
 * Account sign-in form, shared by the popup (on the cover, 'cover') and the
 * options page ('paper'). It only sends the account messages: the session
 * token, ticket and MFA token stay in the background; this sees the step
 * and the email only.
 */

function send(req: ExtRequest): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res as ExtResponse);
    });
  });
}

const ERROR_KEYS = {
  'signed-out': 'errSignedOut',
  'server-not-configured': 'serverNotConfigured',
  'invalid-server-url': 'errInvalidServerUrl',
  'invalid-email': 'errInvalidEmail',
  'email-unavailable': 'errEmailUnavailable',
  'code-failed': 'errCodeFailed',
  'code-expired': 'errCodeExpired',
  'mfa-failed': 'errMfaFailed',
  'verification-failed': 'errVerificationFailed',
  'device-rejected': 'errDeviceRejected',
  'provider-unavailable': 'errProviderUnavailable',
  cancelled: 'errCancelled',
  offline: 'errOffline',
  unknown: 'errUnknown',
} as const satisfies Record<AuthErrorCode, string>;

export function useAuthErrorText(): (res: ExtResponse) => string {
  const x = useTranslation().dict.extension;
  return (res) => (!res.ok && res.authError ? x[ERROR_KEYS[res.authError]] : !res.ok ? res.error : x.errUnknown);
}

export default function SignIn({ account, onChange, tone }: { account: AccountStatus; onChange: (a: AccountStatus) => void; tone: 'cover' | 'paper' }) {
  const x = useTranslation().dict.extension;
  const errorText = useAuthErrorText();
  const [email, setEmail] = useState(account.email ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'' | 'email' | 'code' | 'google'>('');
  const [error, setError] = useState('');
  const [google, setGoogle] = useState(false);
  const cover = tone === 'cover';

  useEffect(() => {
    if (!account.serverConfigured) { setGoogle(false); return; }
    void send({ type: 'getAuthProviders' })
      .then((res) => setGoogle(res.ok && 'providers' in res && res.providers.google))
      .catch(() => setGoogle(false));
  }, [account.serverConfigured, account.apiBaseUrl]);

  const run = async (kind: 'email' | 'code' | 'google', req: ExtRequest) => {
    setError(''); setBusy(kind);
    try {
      const res = await send(req);
      if (res.ok && 'account' in res) { setCode(''); onChange(res.account); }
      else {
        setError(errorText(res));
        // A spent ticket or MFA token sends the user back to the email step.
        if (!res.ok && (res.authError === 'code-expired' || res.authError === 'mfa-failed')) {
          const now = await send({ type: 'getAccount' });
          if (now.ok && 'account' in now) onChange(now.account);
        }
      }
    } catch {
      setError(x.errUnknown);
    } finally {
      setBusy('');
    }
  };

  const field = (id: string, label: string, input: ReactNode) => (
    <div>
      <label className={cover ? 'flabel' : 'label'} htmlFor={id}>{label}</label>
      {cover ? <div className={`cfield${error ? ' invalid' : ''}`}>{input}</div> : input}
    </div>
  );
  const primary = cover ? 'btn lg wide btn-primary' : 'btn btn-primary';
  const quiet = cover ? 'btn wide btn-quiet' : 'btn-secondary';
  const link = cover ? 'btn-link alt' : 'btn-link';
  const errorEl = error && (cover
    ? <Msg icon="circle-alert" className="oncover err"><span role="alert">{error}</span></Msg>
    : <p className="note err" role="alert">{error}</p>);
  const inputClass = cover ? undefined : 'input';

  if (!account.serverConfigured) {
    return (
      <div className="stack">
        <Msg icon="info" className={cover ? 'oncover' : undefined}>{x.serverNotConfigured}</Msg>
        {cover && <button className={quiet} type="button" onClick={() => { void chrome.runtime.openOptionsPage(); }}>{x.openSettings}</button>}
      </div>
    );
  }

  if (account.step === 'email-code' || account.step === 'mfa') {
    const mfa = account.step === 'mfa';
    return (
      <form className="stack" data-testid={mfa ? 'signin-mfa' : 'signin-code'} noValidate
        onSubmit={(e) => { e.preventDefault(); void run('code', mfa ? { type: 'verifyMfa', code } : { type: 'verifyEmailCode', code }); }}>
        <p className={cover ? 'lede' : 'ink2'} style={{ margin: 0 }}>{mfa ? x.mfaLede : format(x.codeSentTo, account.email ?? '')}</p>
        {field('signin-code', mfa ? x.mfaCode : x.signInCode,
          <input id="signin-code" name="one-time-code" className={inputClass} type="text" inputMode={mfa ? 'text' : 'numeric'} autoComplete="one-time-code"
            value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-invalid={error ? true : undefined} />)}
        {errorEl}
        <button className={primary} type="submit" disabled={busy !== ''}>{busy === 'code' ? x.signingIn : mfa ? x.verifyMfa : x.verifyCode}</button>
        {!mfa && (
          <button className={quiet} type="button" disabled={busy !== ''} onClick={() => void run('email', { type: 'requestEmailCode', email: account.email ?? '' })}>{x.sendNewCode}</button>
        )}
        <button className={link} type="button" onClick={() => void run('email', { type: 'cancelSignIn' })}>{mfa ? x.startOver : x.useDifferentEmail}</button>
      </form>
    );
  }

  return (
    <form className="stack" data-testid="signin-email" noValidate
      onSubmit={(e) => { e.preventDefault(); void run('email', { type: 'requestEmailCode', email }); }}>
      {field('signin-email', x.email,
        <input id="signin-email" name="email" className={inputClass} type="email" autoComplete="email" placeholder={x.emailPlaceholder}
          value={email} onChange={(e) => setEmail(e.target.value)} autoFocus aria-invalid={error ? true : undefined} />)}
      {errorEl}
      <button className={primary} type="submit" disabled={busy !== ''}>{busy === 'email' ? x.signingIn : x.sendCode}</button>
      {google && (
        <>
          <p className={cover ? 'msg oncover' : 'ink3'} style={{ justifyContent: 'center' }}>{x.orDivider}</p>
          <button className={quiet} type="button" disabled={busy !== ''} onClick={() => void run('google', { type: 'signInWithGoogle' })}>{x.continueWithGoogle}</button>
          {busy === 'google' && <Msg icon="info" className={cover ? 'oncover' : undefined}>{x.waitingForGoogle}</Msg>}
        </>
      )}
    </form>
  );
}
