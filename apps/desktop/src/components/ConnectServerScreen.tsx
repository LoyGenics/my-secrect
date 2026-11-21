import { useState, type FormEvent } from 'react';
import { Art, Icon, brandMark, illustrations } from '../theme';
import './signin.css';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { isAcceptableApiBaseUrl } from '../authGate';

/**
 * Blocking first step when this build has no default account server and none
 * is saved (authGate.ts): every vault belongs to an account, so the app asks
 * where that account lives before anything else. Also reached from the
 * sign-in screen ("Use a different account server"), then with Cancel.
 */
export default function ConnectServerScreen({ initialUrl, onConnect, onCancel }: {
  initialUrl: string;
  onConnect: (url: string) => void;
  onCancel?: () => void;
}) {
  const { dict } = useTranslation();
  const s = dict.signin;
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isAcceptableApiBaseUrl(url)) {
      setError(true);
      return;
    }
    onConnect(url.trim().replace(/\/+$/, ''));
  };

  return (
    <div className="si">
      {/* Same cover panel as SignInScreen. */}
      <aside className="si-aside">
        <div className="si-brand">
          <img className="ms-brand-img" src={brandMark.src} alt="" width={36} height={36} />
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
        </ul>
      </aside>
      <main className="si-main">
        <div className="si-card">
          <div className="si-compact">
            <Art src={illustrations.deviceHero} size={76} eager className="si-compact__art" />
            <span className="si-brand">My Secret</span>
          </div>
          <h1>{s.connectTitle}</h1>
          <p className="si-sub">{s.connectBody}</p>
          <form className="si-step" onSubmit={submit} noValidate>
            <div className="si-field">
              <label className="si-label" htmlFor="connect-server-url">{s.connectUrlLabel}</label>
              <div className="si-input">
                <Icon name="server" size="lg" />
                <input
                  id="connect-server-url"
                  name="connect-server-url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setError(false); }}
                  placeholder="https://"
                  aria-invalid={error}
                  aria-describedby="connect-server-hint"
                  autoFocus
                />
              </div>
              <p id="connect-server-hint" className="si-hint">{s.connectUrlHint}</p>
            </div>
            {error && <p role="alert" className="si-alert">{s.connectUrlInvalid}</p>}
            <button type="submit" className="si-btn si-btn--primary" disabled={!url.trim()}>
              <Icon name="enter" size="lg" />
              {s.connectButton}
            </button>
            {onCancel && <button type="button" className="si-link" onClick={onCancel}>{s.back}</button>}
          </form>
        </div>
      </main>
    </div>
  );
}
