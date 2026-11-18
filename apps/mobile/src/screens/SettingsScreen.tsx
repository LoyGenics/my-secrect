import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import Field from '../components/Field';
import { useMobileTheme } from '../theme';
import {
  changePassphrase, disableDeviceUnlock, enableDeviceUnlockWithPassphrase, exportEncrypted, getDeviceUnlockState, verifyPassphrase, wipeVault,
  type DeviceUnlockState,
} from '../vault';
import { biometryName, deviceUnlockMessage } from './LockScreen';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, LS_ACCOUNT_EMAIL, SecurityApiClient } from '../../../../packages/sdk/src/security';
import { getApiToken } from './SecurityScreen';
import { API_BASE_URL_KEY, SHARE_WEB_ORIGIN_KEY } from '../accountServer';
import { isStepUpRequired } from '../utils/stepUp';
import { Action, Group, Page, Row, Rule, Select } from '../components/mobile-ui';
import { Archive, ChevronLeft, Fingerprint, Globe, Image, KeyRound, Lock, LogIn, Search, ShieldCheck, Trash2, Users, Share2, X } from 'lucide-react-native';
import { removeAllEncryptedFiles } from '../storage/localFiles';
import { GhostBrandMark } from '../components/soft';

export type AutoLockMinutes = 1 | 5 | 15 | 0;

type PendingAction = 'export' | 'change' | 'wipe';

export default function SettingsScreen({ autoLock, onAutoLockChange, onLock, onWiped, notice, setNotice, onViewTrash, onViewSecurity, onOpen, onSearch, apiBaseUrl, signedIn, onSignIn, onServerSaved }: {
  autoLock: AutoLockMinutes; onAutoLockChange: (m: AutoLockMinutes) => void; onLock: () => void; onWiped: () => void;
  notice: string; setNotice: (s: string) => void; onViewTrash: () => void; onViewSecurity: () => void; onOpen?: (screen: 'Family' | 'Shares') => void; onSearch?: () => void; onServerSaved?: (url: string) => Promise<void>;
  apiBaseUrl: string; signedIn: boolean; onSignIn: () => void;
}) {
  const { colors, styles } = useMobileTheme();
  const { t, dict, locale, setLocale } = useTranslation();
  const [panel, setPanel] = useState<'unlock' | 'change' | 'backup' | 'server' | 'delete' | 'about' | null>(null);
  const [serverSaved, setServerSaved] = useState(false);
  const [serverDraft, setServerDraft] = useState('');
  const [webOrigin, setWebOrigin] = useState('');
  const [serverError, setServerError] = useState('');
  function closePanel() { setPanel(null); setNewPass(''); setNewConfirm(''); setStepUpAction(null); setStepUpPass(''); setStepUpCode(''); setStepUpError(''); setBioPass(''); setExported(''); setWipeArmed(false); }
  const [newPass, setNewPass] = useState('');
  const [newConfirm, setNewConfirm] = useState('');
  const [changeError, setChangeError] = useState('');
  const [changeOk, setChangeOk] = useState(false);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [exported, setExported] = useState('');
  // Step-up state: every sensitive local action (export / change
  // passphrase / wipe) opens this panel first. See submitStepUp().
  const [stepUpAction, setStepUpAction] = useState<PendingAction | null>(null);
  const [stepUpPass, setStepUpPass] = useState('');
  const [stepUpCode, setStepUpCode] = useState('');
  const [stepUpError, setStepUpError] = useState('');
  const [stepUpBusy, setStepUpBusy] = useState(false);
  // Biometric unlock (specs/mobile-local-store.md §4).
  const [device, setDevice] = useState<DeviceUnlockState | null>(null);
  const [bioPass, setBioPass] = useState('');
  const [bioMessage, setBioMessage] = useState('');
  const [bioBusy, setBioBusy] = useState(false);
  const bioName = biometryName(device?.biometry);

  useEffect(() => {
    void getDeviceUnlockState().then(setDevice);
    if (__DEV__) void AsyncStorage.getItem(SHARE_WEB_ORIGIN_KEY).then(value => setWebOrigin(value ?? '')).catch(() => undefined);
  }, []);

  /** Turning it on needs the passphrase again: that unlock is what releases the Master Key copy to wrap. */
  async function enableBiometric() {
    setBioMessage(''); setBioBusy(true);
    const result = await enableDeviceUnlockWithPassphrase(bioPass, `Turn on ${bioName} unlock for my-secrect`);
    setBioBusy(false); setBioPass('');
    setDevice(await getDeviceUnlockState());
    setBioMessage(result.ok ? `${bioName} unlock is on.` : result.code === 'USER_CANCEL' ? `${bioName} unlock was not turned on.` : `${bioName} unlock could not be turned on: ${deviceUnlockMessage(result.code, bioName)}`);
  }
  async function disableBiometric() {
    setBioMessage(''); setBioBusy(true);
    try { await disableDeviceUnlock(); setBioMessage(`${bioName} unlock is off. The device key was deleted.`); }
    catch { setBioMessage(`${bioName} unlock could not be fully turned off. Try again.`); }
    setBioBusy(false);
    setDevice(await getDeviceUnlockState());
  }

  const apiConfigured = apiBaseUrl.trim() !== '';
  const requiresAccountVerification = apiConfigured && (__DEV__ || signedIn);

  async function saveApiBaseUrl(v: string) {
    setServerError(''); setServerSaved(false);
    try {
      const target = webOrigin.trim();
      if (target) {
        const parsed = new URL(target);
        if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) || parsed.username || parsed.password) throw new Error('invalid URL');
      }
      if (v) { const parsed = new URL(v); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid URL'); }
      const next = v.replace(/\/+$/, '');
      if (next !== apiBaseUrl) {
        // The bearer session belongs to the previously configured server.
        await AsyncStorage.multiRemove([LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, LS_ACCOUNT_EMAIL]);
      }
      await AsyncStorage.multiSet([[API_BASE_URL_KEY, next], [SHARE_WEB_ORIGIN_KEY, target]]);
      setServerSaved(true);
      await onServerSaved?.(next);
    } catch { setServerError(t('mobileUI.saveFailed')); }
  }

  function requestExport() { setChangeError(''); setStepUpError(''); setStepUpAction('export'); }
  function requestChangePassphrase() {
    setChangeError(''); setChangeOk(false);
    if (newPass.length < 8) { setChangeError('New passphrase must be at least 8 characters.'); return; }
    if (newPass !== newConfirm) { setChangeError('New passphrases do not match.'); return; }
    setStepUpError(''); setStepUpAction('change');
  }
  function requestWipe() { setStepUpError(''); setStepUpAction('wipe'); }

  /**
   * Step-up gate for export / change passphrase / wipe.
   * (i) Local: re-enter the master passphrase, verified with
   * verifyPassphrase() — a wrong entry cannot lock the open vault.
   * (ii) When account verification applies: a TOTP code,
   * verified with POST /v1/auth/step-up/totp. A 403 step_up_required
   * re-prompts with the expired message; any other failure shows the
   * failed message. Nothing proceeds until both pass. The passphrase and
   * code are cleared from state as soon as the action runs.
   */
  async function submitStepUp() {
    const action = stepUpAction; if (!action) return;
    setStepUpError(''); setStepUpBusy(true);
    const okPass = await verifyPassphrase(stepUpPass);
    if (!okPass) { setStepUpBusy(false); setStepUpError(t('security.stepUpFailed')); return; }
    if (requiresAccountVerification) {
      if (!stepUpCode.trim()) { setStepUpBusy(false); setStepUpError(t('security.stepUpFailed')); return; }
      try {
        const c = new SecurityApiClient({ baseUrl: apiBaseUrl.trim(), getToken: getApiToken });
        await c.stepUpTotp(stepUpCode.trim());
      } catch (e) {
        setStepUpBusy(false);
        setStepUpError(isStepUpRequired(e) ? t('security.stepUpExpired') : t('security.stepUpFailed'));
        return; // panel stays open: re-prompt, never proceed.
      }
    }
    const pass = stepUpPass;
    setStepUpAction(null); setStepUpPass(''); setStepUpCode(''); setStepUpBusy(false);
    if (action === 'export') await doExport();
    else if (action === 'change') await doChangePassphrase(pass);
    else await doWipe();
  }

  async function doExport() {
    try { const json = await exportEncrypted(); setExported(json); await Clipboard.setStringAsync(json); setNotice('Encrypted backup copied. Keep it somewhere safe.'); }
    catch { setNotice('Export failed.'); }
  }
  async function doChangePassphrase(verifiedOldPass: string) {
    setChangeError(''); setChangeOk(false);
    const biometricWasOn = device?.enrolled === true;
    try {
      await changePassphrase(verifiedOldPass, newPass); setNewPass(''); setNewConfirm(''); setChangeOk(true);
      if (biometricWasOn) setBioMessage(`${bioName} unlock was turned off with the passphrase change. Turn it on again below if you want it.`);
    } catch (e) { setChangeError(e instanceof Error ? e.message : 'Could not change the passphrase.'); }
    setDevice(await getDeviceUnlockState());
  }
  async function doWipe() { await wipeVault(); await removeAllEncryptedFiles().catch(() => undefined); onWiped(); }

  const panelTitle = panel === 'unlock' ? t('mobileUI.unlockSettings') : panel === 'change' ? t('mobileUI.changePassphrase') : panel === 'backup' ? t('mobileUI.backupSettings') : panel === 'server' ? t('mobileUI.serverSettings') : panel === 'delete' ? t('mobileUI.dangerZone') : t('mobileUI.about');
  const icon = (Node: typeof Lock) => <Node size={21} color={colors.secondary} />;
  const hint = (text: string) => <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 20 }}>{text}</Text>;
  return <>
    <Page>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 26, paddingHorizontal: 12 }}>
        <GhostBrandMark /><View><Text style={{ color: colors.text, fontSize: 20, fontWeight: '600' }}>My Secret</Text><Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{t('mobileUI.localOnly')}</Text></View>
      </View>
      <Group title={t('mobileUI.vaultSettings')}>
        <Row testID="settings-unlock" icon={icon(Fingerprint)} label={t('mobileUI.unlockSettings')} detail={autoLock === 0 ? t('mobileUI.never') : t('mobileUI.minutes', autoLock)} onPress={() => setPanel('unlock')} /><Rule />
        <Row testID="settings-passphrase" icon={icon(KeyRound)} label={t('mobileUI.changePassphrase')} onPress={() => setPanel('change')} /><Rule />
        <Row testID="settings-backup" icon={icon(Archive)} label={t('mobileUI.backupSettings')} onPress={() => setPanel('backup')} /><Rule />
        <Row testID="view-trash-button" icon={icon(Trash2)} label={dict.shell.trash} onPress={onViewTrash} />
      </Group>
      <Group title={t('mobileUI.accountSettings')}>
        {apiConfigured && !signedIn && <><Row testID="settings-sign-in" icon={icon(LogIn)} label={t('signin.signIn')} onPress={onSignIn} /><Rule /></>}
        <Row testID="security-center-button" icon={icon(ShieldCheck)} label={t('security.title')} onPress={onViewSecurity} /><Rule />
        <Row testID="settings-sharing" icon={icon(Share2)} label={t('mobileUI.sharing')} onPress={() => onOpen?.('Shares')} /><Rule />
        <Row testID="settings-family" icon={icon(Users)} label={t('mobileUI.familyPlan')} onPress={() => onOpen?.('Family')} />
      </Group>
      <Group title={dict.settings.preferencesTitle}>
        <View style={{ paddingHorizontal: 16 }}><Select label={t('mobileUI.language')} testID="settings-language" value={locale} choices={[{ value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' }]} onChange={value => setLocale(value as 'en' | 'vi')} /></View><Rule />
        {__DEV__ && <><Row testID="settings-server" icon={icon(Globe)} label={t('mobileUI.serverSettings')} detail={apiConfigured ? t('mobileUI.connected') : t('mobileUI.notConnected')} onPress={() => { setServerDraft(apiBaseUrl); setPanel('server'); }} /><Rule /></>}
        <Row testID="settings-about" label={t('mobileUI.about')} onPress={() => setPanel('about')} />
      </Group>
      <Group><Row testID="lock-now-button" icon={icon(Lock)} label={t('mobileUI.lockNow')} onPress={onLock} /></Group>
      <Row testID="settings-delete" label={t('mobileUI.dangerZone')} destructive onPress={() => setPanel('delete')} />
    </Page>
    <Modal visible={panel !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={closePanel} onDismiss={closePanel}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 18, fontWeight: '600', flex: 1, marginLeft: 8 }}>{panelTitle}</Text>
          {!!onSearch && <Pressable testID="settings-panel-search" accessibilityRole="button" accessibilityLabel={t('mobileUI.searchAll')} onPress={() => { closePanel(); onSearch(); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Search size={21} color={colors.link} /></Pressable>}
          <Pressable testID="settings-panel-close" accessibilityRole="button" accessibilityLabel={dict.common.close} onPress={closePanel} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><X size={22} color={colors.link} /></Pressable>
        </View>
        <Page>
          {stepUpAction ? <>
            <Text style={[styles.heading, { marginBottom: 12 }]}>{t('security.stepUpTitle')}</Text>
            {hint(t('security.stepUpBody'))}
            <Field label={t('security.stepUpPassphraseLabel')} testID="stepup-passphrase" secureTextEntry value={stepUpPass} onChangeText={setStepUpPass} autoCapitalize="none" autoCorrect={false} />
            {requiresAccountVerification && <Field label={t('security.stepUpTotpLabel')} testID="stepup-totp-code" value={stepUpCode} onChangeText={setStepUpCode} autoCapitalize="none" autoCorrect={false} keyboardType="number-pad" />}
            {!!stepUpError && <Text testID="stepup-error" style={[styles.error, { marginBottom: 14 }]}>{stepUpError}</Text>}
            <Action testID="stepup-confirm" label={stepUpBusy ? dict.common.loading : t('security.confirm')} disabled={stepUpBusy} onPress={() => void submitStepUp()} />
            <View style={{ marginTop: 12 }}><Action testID="stepup-cancel" secondary label={dict.common.cancel} disabled={stepUpBusy} onPress={() => { setStepUpAction(null); setStepUpPass(''); setStepUpCode(''); setStepUpError(''); }} /></View>
          </> : panel === 'unlock' ? <>
            <Group title={t('mobileUI.autoLock')}><View style={{ paddingHorizontal: 16 }}><Select testID="settings-autolock" label={t('mobileUI.autoLock')} value={String(autoLock)} choices={[1,5,15,0].map(minutes => ({ value: String(minutes), label: minutes === 0 ? t('mobileUI.never') : t('mobileUI.minutes', minutes) }))} onChange={value => onAutoLockChange(Number(value) as AutoLockMinutes)} /></View></Group>
            {hint(device?.enrolled ? `${bioName} unlock is on.` : device?.available ? `Turn on ${bioName} to unlock this vault on this device.` : `${bioName} is not available. Set it up in your device settings first.`)}
            {device?.enrolled ? <Action testID="disable-biometric-button" secondary label={`Turn off ${bioName}`} disabled={bioBusy} onPress={() => void disableBiometric()} /> : device?.available ? <>
              <Field label={dict.settings.current} testID="biometric-passphrase" secureTextEntry value={bioPass} onChangeText={setBioPass} autoCapitalize="none" autoCorrect={false} />
              <Action testID="enable-biometric-settings-button" label={`Turn on ${bioName}`} disabled={bioBusy || !bioPass} onPress={() => void enableBiometric()} />
            </> : null}
            {!!bioMessage && <Text testID="biometric-message" style={[styles.body, { marginTop: 16 }]}>{bioMessage}</Text>}
          </> : panel === 'change' ? <>
            <Field label={dict.settings.newPassphrase} testID="new-passphrase" secureTextEntry value={newPass} onChangeText={setNewPass} autoCapitalize="none" autoCorrect={false} />
            <Field label={dict.settings.confirm} testID="confirm-new-passphrase" secureTextEntry value={newConfirm} onChangeText={setNewConfirm} autoCapitalize="none" autoCorrect={false} />
            {!!changeError && <Text testID="change-passphrase-error" style={[styles.error, { marginBottom: 16 }]}>{changeError}</Text>}
            {changeOk && hint(t('mobileUI.saved'))}
            <Action testID="change-passphrase-button" label={dict.settings.change} onPress={requestChangePassphrase} />
          </> : panel === 'backup' ? <>
            {hint(t('mobileUI.backupHelp'))}
            <Action testID="export-encrypted-button" label={t('mobileUI.exportBackup')} onPress={requestExport} />
            {!!exported && <Text accessibilityLiveRegion="polite" style={{ color: colors.okText, fontSize: 15, marginTop: 20 }}>{t('mobileUI.backupCopied')}</Text>}
          </> : panel === 'server' ? <>
            <Field label={t('mobileUI.serverURL')} testID="api-base-url" placeholder="https://vault.example.com/api" value={serverDraft} onChangeText={value => { setServerDraft(value); setServerSaved(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            <Field label={t('mobileUI.webAppURL')} testID="share-web-origin" placeholder="https://vault.example.com" value={webOrigin} onChangeText={setWebOrigin} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            {!!serverError && <Text accessibilityRole="alert" style={[styles.error, { marginBottom: 16 }]}>{serverError}</Text>}
            <Action testID="save-api-server" label={t('mobileUI.saveServer')} onPress={() => void saveApiBaseUrl(serverDraft.trim())} />
            {serverSaved && <Text accessibilityLiveRegion="polite" style={{ color: colors.okText, marginTop: 16 }}>{t('mobileUI.saved')}</Text>}
          </> : panel === 'delete' ? <>
            {hint(t('mobileUI.dangerHelp'))}
            <Action testID="wipe-vault-button" destructive label={t('mobileUI.dangerZone')} onPress={() => Alert.alert(dict.settings.wipeTitle, dict.settings.wipeBody, [{ text: dict.common.cancel, style: 'cancel' }, { text: dict.common.delete, style: 'destructive', onPress: requestWipe }])} />
          </> : panel === 'about' ? <>
            {hint(t('mobileUI.aboutBody'))}
            <Group><Row label={dict.settings.encryption} detail={dict.settings.encryptionValue} /></Group>
          </> : null}
        </Page>
      </SafeAreaView>
    </Modal>
  </>;
}
