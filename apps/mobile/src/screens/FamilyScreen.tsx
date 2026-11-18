import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { FamilyApiClient, familyErrorKey, type FamilyState } from '../../../../packages/sdk/src/family';
import { isStepUpRequired, SecurityApiClient } from '../../../../packages/sdk/src/security';
import { isSessionUnauthorized } from '../utils/stepUp';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { AppButton, AppPage, BottomSheet, EmptyState, FormSection, Group, IconButton, InlineError, Progress, Rule, SettingsRow } from '../components/mobile-ui';
import { illustrations } from '../../../../packages/ui/src/native';
import { AppTextField } from '../components/Field';
import { getApiToken } from './SecurityScreen';

type Action = () => Promise<FamilyState>;
export default function FamilyScreen({ baseUrl, onUnauthorized }: { baseUrl: string; onUnauthorized: () => void }) {
  const { t } = useTranslation();
  const [api, setApi] = useState<FamilyApiClient | null>(null);
  const security = useRef<SecurityApiClient | null>(null);
  const alive = useRef(true);
  const [state, setState] = useState<FamilyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<Action | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<{ id: string; email: string }>();
  const dismissVerification = () => { setPending(null); setCode(''); setError(''); };
  async function run(action: Action) {
    setBusy(true); setError('');
    try { const result = await action(); if (alive.current) { setState(result); setEmail(''); } }
    catch (e) {
      if (!alive.current) return;
      if (isSessionUnauthorized(e)) onUnauthorized();
      else if (isStepUpRequired(e)) setPending(() => action);
      else setError(t(familyErrorKey(e)));
    }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    if (!baseUrl) return;
    const client = new FamilyApiClient({ baseUrl, getToken: getApiToken });
    security.current = new SecurityApiClient({ baseUrl, getToken: getApiToken });
    setApi(client); void run(() => client.get());
    return () => { alive.current = false; security.current = null; };
  }, [baseUrl, onUnauthorized]);
  function confirm(label: string, action: Action) {
    Alert.alert(label, t('family.confirmHelp'), [
      { text: t('family.cancel'), style: 'cancel' },
      { text: t('family.confirm'), style: 'destructive', onPress: () => void run(action) },
    ]);
  }
  async function verify(method: 'email' | 'totp') {
    if (!security.current || !pending) return;
    setBusy(true); setError('');
    const action = pending;
    try {
      if (method === 'email') await security.current.stepUpEmail(code);
      else await security.current.stepUpTotp(code);
      setCode(''); setPending(null); await run(action);
    } catch (e) {
      if (isSessionUnauthorized(e)) onUnauthorized();
      else setError(t('family.verificationHelp'));
    }
    finally { if (alive.current) setBusy(false); }
  }
  const family = state?.family;
  const invitation = state?.invitation;
  const mine = family?.members.find(member => member.user_id === state?.current_user_id);

  if (!baseUrl) {
    return <AppPage><EmptyState image={illustrations.deviceHero} title={t('mobileUI.familyConnect')} detail={t('mobileUI.familyConnectBody')} /></AppPage>;
  }
  return (
    <AppPage safeArea="bottom" testID="family-screen">
      {error && !pending ? <InlineError testID="family-error">{error}</InlineError> : null}
      {!api || (!state && busy) ? <Progress label={t('family.loading')} /> : !state ? (
        <AppButton label={t('family.retry')} variant="secondary" onPress={() => void run(() => api.get())} />
      ) : invitation ? (
        <FormSection title={t('family.invitation', invitation.owner_email)} description={t('family.existing')}>
          <AppButton label={t('family.accept')} loading={busy} onPress={() => void run(() => api.accept(invitation.id))} />
          <AppButton label={t('family.decline')} variant="secondary" disabled={busy} onPress={() => confirm(t('family.decline'), () => api.remove(invitation.id))} />
        </FormSection>
      ) : !family ? (
        <EmptyState title={t('family.empty')}>
          <AppButton label={t('family.create')} icon="add" loading={busy} onPress={() => void run(() => api.create())} />
        </EmptyState>
      ) : (
        <>
          <Group title={t('family.seats', family.members.length, family.seats)}>
            {family.members.map((member, index) => (
              <React.Fragment key={member.id}>
                {index > 0 && <Rule leading />}
                <SettingsRow icon="person" label={member.email} detail={`${t(`family.${member.role}`)} · ${t(`family.${member.status}`)}`}>
                  {family.role === 'owner' && member.role !== 'owner' && (
                    <IconButton testID={`family-member-${member.id}-options`} accessibilityLabel={`${t('family.remove')} · ${member.email}`} icon="more" disabled={busy} onPress={() => setMemberToRemove(member)} />
                  )}
                </SettingsRow>
              </React.Fragment>
            ))}
          </Group>
          {family.role === 'owner' && (
            <FormSection title={t('family.invite')} description={t('family.existing')}>
              <AppTextField testID="family-invite-email" label={t('family.email')} value={email} onChangeText={setEmail}
                autoComplete="email" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" disabled={busy || family.members.length >= family.seats} />
              <AppButton testID="family-invite" label={t('family.invite')} icon="mail" disabled={!email.trim() || family.members.length >= family.seats}
                loading={busy} onPress={() => void run(() => api.invite(email.trim()))} />
            </FormSection>
          )}
          <Group footer={t('family.independent')}>
            {family.role === 'owner' ? (
              <SettingsRow label={t('family.dissolve')} destructive onPress={busy ? undefined : () => confirm(t('family.dissolve'), () => api.dissolve())} />
            ) : mine && (
              <SettingsRow label={t('family.leave')} destructive onPress={busy ? undefined : () => confirm(t('family.leave'), () => api.remove(mine.id))} />
            )}
          </Group>
        </>
      )}
      {api && state && <AppButton label={t('family.refresh')} variant="text" icon="regenerate" disabled={busy} onPress={() => void run(() => api.get())} />}

      <BottomSheet visible={Boolean(pending)} onClose={dismissVerification} title={t('family.verify')} testID="family-verification">
        <FormSection description={t('family.verificationHelp')}>
          <AppTextField testID="family-verification-code" label={t('family.code')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" />
          {error ? <InlineError>{error}</InlineError> : null}
          <AppButton label={t('family.sendCode')} variant="text" disabled={busy} onPress={() => {
            setBusy(true);
            void security.current?.stepUpEmailRequest().catch(e => {
              if (isSessionUnauthorized(e)) onUnauthorized();
              else setError(t('family.verificationHelp'));
            }).finally(() => setBusy(false));
          }} />
          <AppButton label={t('family.emailCode')} loading={busy} disabled={!code.trim()} onPress={() => void verify('email')} />
          <AppButton label={t('family.totpCode')} variant="secondary" disabled={busy || !code.trim()} onPress={() => void verify('totp')} />
        </FormSection>
      </BottomSheet>

      <BottomSheet visible={Boolean(memberToRemove)} onClose={() => setMemberToRemove(undefined)} title={memberToRemove?.email ?? ''} testID="family-member-actions">
        {api && memberToRemove && (
          <AppButton label={t('family.remove')} variant="destructive" icon="trash" onPress={() => {
            const id = memberToRemove.id;
            setMemberToRemove(undefined);
            confirm(t('family.remove'), () => api.remove(id));
          }} />
        )}
      </BottomSheet>
    </AppPage>
  );
}
