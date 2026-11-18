import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FamilyApiClient, familyErrorKey, type FamilyState } from '../../../../packages/sdk/src/family';
import { isStepUpRequired, SecurityApiClient } from '../../../../packages/sdk/src/security';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { Action, Empty, Group, Page, Row, Rule } from '../components/mobile-ui';
import { illustrations } from '../../../../packages/ui/src/native';
import Field from '../components/Field';
import { MoreHorizontal, UserRound } from 'lucide-react-native';
import { API_BASE_URL_KEY, getApiToken } from './SecurityScreen';

type Action = () => Promise<FamilyState>;
export default function FamilyScreen({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { colors, styles } = useMobileTheme();
  const [api, setApi] = useState<FamilyApiClient | null>(null);
  const security = useRef<SecurityApiClient | null>(null);
  const alive = useRef(true);
  const [state, setState] = useState<FamilyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<Action | null>(null);
  async function run(action: Action) {
    setBusy(true); setError('');
    try { const result = await action(); if (alive.current) { setState(result); setEmail(''); } }
    catch (e) { if (alive.current) { if (isStepUpRequired(e)) setPending(() => action); else setError(t(familyErrorKey(e))); } }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    AsyncStorage.getItem(API_BASE_URL_KEY).then(baseUrl => {
      if (!alive.current || !baseUrl) return;
      const client = new FamilyApiClient({ baseUrl, getToken: getApiToken });
      security.current = new SecurityApiClient({ baseUrl, getToken: getApiToken });
      setApi(client); void run(() => client.get());
    }).catch(() => { if (alive.current) setError(t('family.error')); });
    return () => { alive.current = false; security.current = null; };
  }, []);
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
    } catch { setError(t('family.verificationHelp')); }
    finally { if (alive.current) setBusy(false); }
  }
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy || disabled} onPress={action} style={[styles.ghostButton, { marginTop: 8, opacity: busy || disabled ? 0.5 : 1 }]}><Text style={styles.ghostButtonText}>{label}</Text></Pressable>;
  const body = (text: string) => <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 12 }}>{text}</Text>;
  const family = state?.family;
  const mine = family?.members.find(member => member.user_id === state?.current_user_id);
  return <Page>
    {!api ? <Empty image={illustrations.deviceHero} title={t('mobileUI.familyConnect')} detail={t('mobileUI.familyConnectBody')} /> : <>
      {!!error && <Text accessibilityRole="alert" style={{ color: colors.dangerText, marginBottom: 18 }}>{error}</Text>}
      {pending && <Group title={t('family.verify')} footer={t('family.verificationHelp')}><View style={{ padding: 16 }}>
        <Field testID="family-verification-code" label={t('family.code')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" />
        {button(t('family.sendCode'), () => { setBusy(true); security.current?.stepUpEmailRequest().catch(() => setError(t('family.verificationHelp'))).finally(() => setBusy(false)); })}
        {button(t('family.emailCode'), () => void verify('email'), !code.trim())}{button(t('family.totpCode'), () => void verify('totp'), !code.trim())}
        {button(t('family.cancel'), () => { setPending(null); setCode(''); })}
      </View></Group>}
      {!state ? <Action label={busy ? t('family.loading') : t('family.retry')} disabled={busy} secondary onPress={() => void run(() => api.get())} /> : state.invitation ? <Group footer={t('family.existing')}><View style={{ padding: 16 }}>
        <Text style={{ color: colors.text, fontSize: 17, lineHeight: 25, marginBottom: 16 }}>{t('family.invitation', state.invitation.owner_email)}</Text>
        <Action label={t('family.accept')} disabled={busy} onPress={() => void run(() => api.accept(state.invitation!.id))} />
        {button(t('family.decline'), () => confirm(t('family.decline'), () => api.remove(state.invitation!.id)))}
      </View></Group> : !family ? <Empty title={t('family.empty')}><Action label={t('family.create')} disabled={busy} onPress={() => void run(() => api.create())} /></Empty> : <>
        <Group title={t('family.seats', family.members.length, family.seats)}>
          {family.members.map((member, index) => <React.Fragment key={member.id}>{index > 0 && <Rule />}<Row label={member.email} detail={`${t(`family.${member.role}`)} · ${t(`family.${member.status}`)}`} icon={<UserRound size={22} color={colors.muted} />}>
            {family.role === 'owner' && member.role !== 'owner' ? <Pressable accessibilityRole="button" accessibilityLabel={`${t('family.remove')}: ${member.email}`} disabled={busy} onPress={() => confirm(t('family.remove'), () => api.remove(member.id))} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><MoreHorizontal size={22} color={colors.muted} /></Pressable> : <View />}
          </Row></React.Fragment>)}
        </Group>
        {family.role === 'owner' && <Group title={t('family.invite')} footer={t('family.existing')}><View style={{ padding: 16 }}>
          <Field testID="family-invite-email" label={t('family.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" editable={!busy && family.members.length < family.seats} />
          <Action testID="family-invite" label={t('family.invite')} disabled={busy || !email.trim() || family.members.length >= family.seats} onPress={() => void run(() => api.invite(email))} />
        </View></Group>}
        <Group footer={t('family.independent')}>
          <Row label={family.role === 'owner' ? t('family.dissolve') : t('family.leave')} destructive onPress={busy ? undefined : () => family.role === 'owner' ? confirm(t('family.dissolve'), () => api.dissolve()) : mine && confirm(t('family.leave'), () => api.remove(mine.id))} />
        </Group>
      </>}
      {!!state && <Action label={t('family.refresh')} secondary disabled={busy} onPress={() => void run(() => api.get())} />}
    </>}
  </Page>;
}
