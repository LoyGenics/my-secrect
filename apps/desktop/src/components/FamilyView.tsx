import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FamilyApiClient, familyErrorKey, type FamilyState } from '../../../../packages/sdk/src/family';
import { getValidToken, isStepUpRequired, SecurityApiClient, webTokenStore } from '../../../../packages/sdk/src/security';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Button, Card, Input } from '../theme';
import StepUpDialog from './StepUpDialog';

type Action = () => Promise<FamilyState>;
export default function FamilyView({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<FamilyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [stepUp, setStepUp] = useState<Action | null>(null);
  const [confirmation, setConfirmation] = useState<{ label: string; action: Action } | null>(null);
  const generation = useRef(0);
  const api = useMemo(() => new FamilyApiClient({ baseUrl: apiBaseUrl, getToken: () => getValidToken(webTokenStore()) }), [apiBaseUrl]);
  const security = useMemo(() => new SecurityApiClient({ baseUrl: apiBaseUrl, getToken: () => getValidToken(webTokenStore()) }), [apiBaseUrl]);
  const run = useCallback(async (action: Action) => {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = await action();
      if (version === generation.current) { setState(result); setEmail(''); setConfirmation(null); }
    } catch (e) {
      if (version !== generation.current) return;
      if (isStepUpRequired(e)) setStepUp(() => action);
      else setError(t(familyErrorKey(e)));
    } finally { if (version === generation.current) setBusy(false); }
  }, [t]);
  useEffect(() => {
    generation.current++; setState(null); setEmail(''); setError(''); setStepUp(null); setConfirmation(null);
    if (apiBaseUrl) void run(() => api.get());
    return () => { generation.current++; };
  }, [api, apiBaseUrl, run]);
  const family = state?.family;
  const currentMember = family?.members.find(member => member.user_id === state?.current_user_id);
  return (
    <Card as="section" padding="lg" aria-labelledby="family-heading">
      <h3 id="family-heading" className="ms-heading ms-heading--md">{t('family.title')}</h3>
      <p className="ms-text-sm ms-text-muted mt-2">{t('family.intro')}</p>
      <p className="ms-text-sm ms-text-muted mt-2">{t('family.privacy')}</p>
      {apiBaseUrl && state && <Button className="mt-3" size="sm" disabled={busy} onClick={() => void run(() => api.get())}>{t('family.refresh')}</Button>}
      {error && <p role="alert" className="ms-text-sm mt-3">{error}</p>}
      {!apiBaseUrl ? <p className="ms-text-sm mt-4">{t('family.signedOut')}</p> : !state ? <Button className="mt-4" disabled={busy} onClick={() => void run(() => api.get())}>{busy ? t('family.loading') : t('family.retry')}</Button> : <>
        {state.invitation ? <div className="mt-5 grid gap-3">
          <p>{t('family.invitation', state.invitation.owner_email)}</p>
          <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void run(() => api.accept(state.invitation!.id))}>{t('family.accept')}</Button><Button disabled={busy} onClick={() => setConfirmation({ label: t('family.decline'), action: () => api.remove(state.invitation!.id) })}>{t('family.decline')}</Button></div>
        </div> : !family ? <div className="mt-5"><p className="ms-text-sm mb-3">{t('family.empty')}</p><Button disabled={busy} onClick={() => void run(() => api.create())}>{t('family.create')}</Button></div> : <div className="mt-5 grid gap-4">
          <p className="ms-text-sm">{t('family.seats', family.members.length, family.seats)}</p>
          <ul className="grid gap-3 list-none p-0 m-0">{family.members.map(member => <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ms-border)] pb-3">
            <div><p className="ms-text-sm break-all">{member.email}</p><p className="ms-text-xs ms-text-muted">{t(`family.${member.role}`)} · {t(`family.${member.status}`)}</p></div>
            {family.role === 'owner' && member.role !== 'owner' && <Button size="sm" disabled={busy} onClick={() => setConfirmation({ label: t('family.remove'), action: () => api.remove(member.id) })}>{t('family.remove')}</Button>}
          </li>)}</ul>
          {family.role === 'owner' && <form className="grid gap-3" onSubmit={e => { e.preventDefault(); void run(() => api.invite(email)); }}>
            <label className="ms-text-sm" htmlFor="family-email">{t('family.email')}</label>
            <Input id="family-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required disabled={busy || family.members.length >= family.seats} />
            <p className="ms-text-xs ms-text-muted">{t('family.existing')}</p>
            <Button type="submit" disabled={busy || !email.trim() || family.members.length >= family.seats}>{t('family.invite')}</Button>
          </form>}
          <p className="ms-text-xs ms-text-muted">{t('family.independent')}</p>
          {family.role === 'owner' ? <Button disabled={busy} onClick={() => setConfirmation({ label: t('family.dissolve'), action: () => api.dissolve() })}>{t('family.dissolve')}</Button> : currentMember && <Button disabled={busy} onClick={() => setConfirmation({ label: t('family.leave'), action: () => api.remove(currentMember.id) })}>{t('family.leave')}</Button>}
        </div>}
      </>}
      {confirmation && <div role="group" aria-label={confirmation.label} className="mt-4 grid gap-3">
        <p className="ms-text-sm">{t('family.confirmHelp')}</p><div className="flex gap-3"><Button disabled={busy} onClick={() => void run(confirmation.action)}>{t('family.confirm')}</Button><Button disabled={busy} onClick={() => setConfirmation(null)}>{t('family.cancel')}</Button></div>
      </div>}
      <StepUpDialog open={stepUp !== null} security={security} serverOnly allowEmail onCancel={() => setStepUp(null)} onVerified={() => { const action = stepUp; setStepUp(null); if (action) void run(action); }} />
    </Card>
  );
}
