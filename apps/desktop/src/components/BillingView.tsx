import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../../packages/sdk/src/index';
import { BillingApiClient, formatBillingPrice, storeManagementUrl, stripeRedirectUrl, type BillingState, type PurchaseOption } from '../../../../packages/sdk/src/billing';
import { getValidToken, webTokenStore } from '../../../../packages/sdk/src/security';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Alert, Button, Card } from '../theme';
import './billing.css';

export default function BillingView({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { dict, locale } = useTranslation();
  const b = dict.billing;
  const [state, setState] = useState<BillingState | null>(null);
  const [option, setOption] = useState<PurchaseOption>('yearly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const api = useMemo(() => new BillingApiClient({ baseUrl: apiBaseUrl, getToken: () => getValidToken(webTokenStore()) }), [apiBaseUrl]);
  const returned = new URLSearchParams(window.location.search).get('billing');

  function errorMessage(e: unknown) {
    if (e instanceof ApiError && e.status === 401) return b.signedOut;
    if (e instanceof ApiError && e.status === 409) return b.conflict;
    if (e instanceof ApiError && e.status === 503) return b.unavailable;
    return b.error;
  }
  useEffect(() => {
    const version = ++generation.current;
    setState(null); setError(''); setBusy(Boolean(apiBaseUrl));
    if (apiBaseUrl) {
      const request = returned === 'success' || returned === 'return' ? api.refresh() : api.get();
      void request.then(next => { if (version === generation.current) setState(next); })
        .catch(e => { if (version === generation.current) setError(errorMessage(e)); })
        .finally(() => { if (version === generation.current) setBusy(false); });
    }
    return () => { generation.current++; };
  }, [api, apiBaseUrl, returned, locale]);

  async function refresh() {
    const version = generation.current;
    setBusy(true); setError('');
    try { const next = await api.refresh(); if (version === generation.current) setState(next); }
    catch (e) { if (version === generation.current) setError(errorMessage(e)); }
    finally { if (version === generation.current) setBusy(false); }
  }
  async function redirect(kind: 'checkout' | 'portal') {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = kind === 'checkout' ? await api.checkout(option) : await api.portal();
      if (version === generation.current) window.location.assign(stripeRedirectUrl(result.url, kind));
    } catch (e) { if (version === generation.current) setError(errorMessage(e)); }
    finally { if (version === generation.current) setBusy(false); }
  }
  const selected = state?.catalog.find(p => p.option === option);
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
  const provider = { stripe: 'Stripe', app_store: 'App Store', google_play: 'Google Play' };
  return <Card as="section" padding="lg" aria-labelledby="billing-heading">
    <div className="billing-head">
      <div><h3 id="billing-heading" className="ms-heading ms-heading--md">{b.title}</h3><p className="ms-text-sm ms-text-muted mt-2">{b.intro}</p></div>
      {state && <span className="billing-tier">{state.tier === 'free' ? b.free : state.lifetime ? b.lifetime : 'Pro'}</span>}
    </div>
    {!apiBaseUrl ? <p className="ms-text-sm mt-4">{b.localOnly}</p> : <>
      {error && <Alert tone="danger" announce className="mt-4">{error}</Alert>}
      {!state ? <Button className="mt-4" loading={busy} onClick={() => void refresh()}>{busy ? b.loading : b.retry}</Button> : <>
        {state.environment === 'test' && <p className="ms-text-xs ms-text-muted mt-3">{b.sandbox}</p>}
        {returned === 'success' && <Alert className="mt-4" announce>{state.tier === 'pro' ? b.activated : b.processing}</Alert>}
        {returned === 'cancel' && <p role="status" className="ms-text-sm mt-3">{b.cancelled}</p>}
        <p className="ms-text-sm mt-4">{state.lifetime ? b.noRenewal : state.expires_at ? `${b.accessUntil} ${date(state.expires_at)}` : b.freeDescription}</p>
        {state.purchases.length > 0 && <ul className="billing-purchases" aria-label={b.purchases}>
          {state.purchases.map(p => <li key={p.id}>
            <div><p className="ms-text-sm font-medium">{b[p.option]} · {provider[p.provider]}</p>
              <p className="ms-text-xs ms-text-muted mt-1">{p.review_required ? b.review : p.entitled ? p.cancel_at_period_end ? b.ending : b.active : b.inactive}{p.expires_at ? ` · ${b.accessUntil} ${date(p.expires_at)}` : p.option === 'lifetime' ? ` · ${b.noRenewal}` : ''}</p></div>
            {p.provider === 'stripe' ? <Button size="sm" disabled={busy || !state.portal_available} onClick={() => void redirect('portal')}>{b.manage}</Button> :
              <Button asChild size="sm"><a href={storeManagementUrl(p.provider, p.option === 'lifetime')} target="_blank" rel="noopener noreferrer">{b.manage}</a></Button>}
          </li>)}
        </ul>}
        {!state.checkout_blocked && <fieldset className="billing-options" disabled={busy}>
          <legend className="ms-text-sm font-medium">{b.choose}</legend>
          <div className="billing-free"><span>{b.free}</span><span className="ms-text-xs ms-text-muted">{b.freeDescription}</span></div>
          {(['monthly', 'yearly', 'lifetime'] as const).map(key => {
            const price = state.catalog.find(p => p.option === key);
            return <label key={key} className={`billing-option${option === key ? ' billing-option--selected' : ''}`}>
              <input type="radio" name="billing-option" checked={option === key} value={key} onChange={() => setOption(key)} />
              <span><strong>{b[key]}</strong><span className="ms-text-xs ms-text-muted">{key === 'lifetime' ? b.once : b.recurring}</span></span>
              <span className="billing-price">{price?.available && price.amount !== undefined && price.currency ? formatBillingPrice(price.amount, price.currency, locale) : b.notConfigured}</span>
            </label>;
          })}
        </fieldset>}
        <div className="billing-actions">
          {!state.checkout_blocked && <Button variant="primary" disabled={busy || !selected?.available} onClick={() => void redirect('checkout')}>{b.continue}</Button>}
          <Button loading={busy} onClick={() => void refresh()}>{b.refresh}</Button>
        </div>
        <p className="ms-text-xs ms-text-muted mt-4">{state.checkout_blocked ? b.existing : b.sharedAccess}</p>
        <p className="ms-text-xs ms-text-muted mt-2">{b.storeHelp}</p>
      </>}
    </>}
  </Card>;
}
