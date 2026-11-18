import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FamilyApiClient, familyErrorKey, type FamilyState } from '../../../../packages/sdk/src/family';
import { isStepUpRequired, SecurityApiClient } from '../../../../packages/sdk/src/security';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
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
  return <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
    {button(t('common.back'), onClose)}
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 28, fontWeight: '600', marginTop: 20 }}>{t('family.title')}</Text>
    {body(t('family.intro'))}{body(t('family.privacy'))}
    {api && state && button(t('family.refresh'), () => void run(() => api.get()))}
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.dangerText, marginTop: 16 }}>{error}</Text>}
    {!api ? body(t('family.signedOut')) : !state ? button(busy ? t('family.loading') : t('family.retry'), () => void run(() => api.get())) : state.invitation ? <View style={{ marginTop: 20 }}>
      {body(t('family.invitation', state.invitation.owner_email))}
      {button(t('family.accept'), () => void run(() => api.accept(state.invitation!.id)))}
      {button(t('family.decline'), () => confirm(t('family.decline'), () => api.remove(state.invitation!.id)))}
    </View> : !family ? <View style={{ marginTop: 20 }}>{body(t('family.empty'))}{button(t('family.create'), () => void run(() => api.create()))}</View> : <View style={{ marginTop: 20 }}>
      {body(t('family.seats', family.members.length, family.seats))}
      {family.members.map(member => <View key={member.id} style={{ paddingVertical: 16, borderBottomWidth: 1, borderColor: colors.cardBorder }}>
        <Text style={{ color: colors.text, fontSize: 15 }}>{member.email}</Text>
        {body(`${t(`family.${member.role}`)} · ${t(`family.${member.status}`)}`)}
        {family.role === 'owner' && member.role !== 'owner' && button(t('family.remove'), () => confirm(t('family.remove'), () => api.remove(member.id)))}
      </View>)}
      {family.role === 'owner' && <View style={{ marginTop: 24 }}>
        <Text style={styles.label}>{t('family.email')}</Text>
        <TextInput accessibilityLabel={t('family.email')} style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" editable={!busy && family.members.length < family.seats} />
        {body(t('family.existing'))}{button(t('family.invite'), () => void run(() => api.invite(email)), !email.trim() || family.members.length >= family.seats)}
      </View>}
      {body(t('family.independent'))}
      {family.role === 'owner' ? button(t('family.dissolve'), () => confirm(t('family.dissolve'), () => api.dissolve())) : mine && button(t('family.leave'), () => confirm(t('family.leave'), () => api.remove(mine.id)))}
    </View>}
    {pending && <View style={{ marginTop: 24, padding: 16, backgroundColor: colors.card, borderRadius: 12 }}>
      <Text style={styles.label}>{t('family.verify')}</Text>{body(t('family.verificationHelp'))}
      {button(t('family.sendCode'), () => { setBusy(true); security.current?.stepUpEmailRequest().catch(() => setError(t('family.verificationHelp'))).finally(() => setBusy(false)); })}
      <Text style={styles.label}>{t('family.code')}</Text><TextInput accessibilityLabel={t('family.code')} style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" />
      {button(t('family.emailCode'), () => void verify('email'), !code.trim())}{button(t('family.totpCode'), () => void verify('totp'), !code.trim())}
      {button(t('family.cancel'), () => { setPending(null); setCode(''); })}
    </View>}
  </ScrollView>;
}
