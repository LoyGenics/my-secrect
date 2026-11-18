import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { AppTextField } from '../components/Field';
import { Icon, type NativeIconName } from '../../../../packages/ui/src/native';
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
import { AppButton, AppPage, BottomSheet, FieldGroup, FormSection, Group, InlineError, PageSection, Rule, SettingsRow } from '../components/mobile-ui';
import { removeAllEncryptedFiles } from '../storage/localFiles';
import { GhostBrandMark } from '../components/soft';
import { useAppPreferences } from '../ui/AppearanceProvider';
import { AUTO_LOCK_CHOICES, type AutoLockMinutes } from '../ui/preferences';
import { space, textStyle } from '../ui/tokens';

export type { AutoLockMinutes } from '../ui/preferences';

type PendingAction = 'export' | 'export-file' | 'change' | 'wipe';

export function AppearanceScreen() {
  const { colors } = useMobileTheme();
  const { dict, t } = useTranslation();
  const { preference, setPreference, persistenceError } = useAppPreferences();
  const choices = [
    { value: 'system', icon: 'system' },
    { value: 'light', icon: 'light' },
    { value: 'dark', icon: 'dark' },
  ] as const;
  return (
    <AppPage testID="appearance-screen">
      <PageSection description={t('mobileUI.appearanceHelp')}>
        <Group>
          {choices.map(({ value, icon }, index) => (
            <React.Fragment key={value}>
              {index > 0 && <Rule leading />}
              <SettingsRow
                testID={`appearance-${value}`}
                label={dict.theme[value]}
                icon={<Icon name={icon} color={colors.secondary} size="lg" />}
                accessibilityRole="radio"
                accessibilityState={{ checked: preference === value }}
                selected={preference === value}
                onPress={() => void setPreference(value)}
              />
            </React.Fragment>
          ))}
        </Group>
      </PageSection>
      {persistenceError && <InlineError testID="appearance-save-error">{t('mobileUI.settingsSaveFailed')}</InlineError>}
    </AppPage>
  );
}

export default function SettingsScreen({ autoLock, onAutoLockChange, onLock, onWiped, setNotice, onViewTrash, onViewArchive, onViewSecurity, onOpen, onAppearance, apiBaseUrl, signedIn, onSignIn, onServerSaved }: {
  autoLock: AutoLockMinutes; onAutoLockChange: (m: AutoLockMinutes) => void; onLock: () => void; onWiped: () => void;
  setNotice: (s: string) => void; onViewTrash: () => void; onViewArchive?: () => void; onViewSecurity: () => void; onOpen?: (screen: 'Family' | 'Shares') => void; onAppearance?: () => void; onServerSaved?: (url: string) => Promise<void>;
  apiBaseUrl: string; signedIn: boolean; onSignIn: () => void;
}) {
  const { colors } = useMobileTheme();
  const { t, dict, tp, locale, setLocale } = useTranslation();
  const { preference, persistenceError } = useAppPreferences();
  const [panel, setPanel] = useState<'unlock' | 'change' | 'backup' | 'server' | 'delete' | 'about' | 'language' | null>(null);
  const [serverSaved, setServerSaved] = useState(false);
  const [serverDraft, setServerDraft] = useState('');
  const [webOrigin, setWebOrigin] = useState('');
  const [serverError, setServerError] = useState('');
  function closePanel() {
    setPanel(null); setNewPass(''); setNewConfirm(''); setChangeError(''); setChangeOk(false);
    setStepUpAction(null); setStepUpPass(''); setStepUpCode(''); setStepUpError('');
    setBioPass(''); setBackupCopied(false); setBackupError('');
  }
  const [newPass, setNewPass] = useState('');
  const [newConfirm, setNewConfirm] = useState('');
  const [changeError, setChangeError] = useState('');
  const [changeOk, setChangeOk] = useState(false);
  const [backupCopied, setBackupCopied] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState('');
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
  const bioName = biometryName(device?.biometry, t);

  useEffect(() => {
    void getDeviceUnlockState().then(setDevice);
    if (__DEV__) void AsyncStorage.getItem(SHARE_WEB_ORIGIN_KEY).then(value => setWebOrigin(value ?? '')).catch(() => undefined);
  }, []);

  /** Turning it on needs the passphrase again: that unlock is what releases the Master Key copy to wrap. */
  async function enableBiometric() {
    setBioMessage(''); setBioBusy(true);
    try {
      const result = await enableDeviceUnlockWithPassphrase(bioPass, t('mobileUI.biometricEnable', bioName));
      setDevice(await getDeviceUnlockState());
      setBioMessage(result.ok ? t('mobileUI.biometricOn', bioName) : deviceUnlockMessage(result.code, bioName, t));
    } catch {
      setBioMessage(t('mobileAuth.bioEnableFailed', bioName));
    } finally { setBioBusy(false); setBioPass(''); }
  }
  async function disableBiometric() {
    setBioMessage(''); setBioBusy(true);
    try {
      await disableDeviceUnlock();
      setDevice(await getDeviceUnlockState());
      setBioMessage(t('mobileUI.biometricOff', bioName));
    } catch { setBioMessage(t('mobileUI.biometricDisableFailed', bioName)); }
    finally { setBioBusy(false); }
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

  function requestExport(action: 'export' | 'export-file') { setBackupError(''); setStepUpError(''); setStepUpAction(action); }
  function requestChangePassphrase() {
    setChangeError(''); setChangeOk(false);
    if (newPass.length < 8) { setChangeError(dict.settings.tooShort); return; }
    if (newPass !== newConfirm) { setChangeError(dict.settings.mismatch); return; }
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
    if (action === 'export' || action === 'export-file') await doExport(action === 'export-file');
    else if (action === 'change') await doChangePassphrase(pass);
    else await doWipe();
  }

  async function doExport(asFile: boolean) {
    setBackupBusy(true); setBackupCopied(false);
    try {
      const json = await exportEncrypted();
      if (asFile) {
        if (!FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
        const uri = `${FileSystem.cacheDirectory}my-secret-backup.json`;
        await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
        await Sharing.shareAsync(uri, { mimeType: 'application/json', UTI: 'public.json' });
      } else {
        await Clipboard.setStringAsync(json);
        setBackupCopied(true);
        setNotice(t('mobileUI.backupCopied'));
      }
    } catch { setBackupError(dict.notices.exportFailed); }
    finally { setBackupBusy(false); }
  }
  async function doChangePassphrase(verifiedOldPass: string) {
    setChangeError(''); setChangeOk(false);
    const biometricWasOn = device?.enrolled === true;
    try {
      await changePassphrase(verifiedOldPass, newPass); setNewPass(''); setNewConfirm(''); setChangeOk(true);
      if (biometricWasOn) setBioMessage(t('mobileUI.biometricChanged', bioName));
    } catch { setChangeError(dict.settings.changeFailed); }
    setDevice(await getDeviceUnlockState());
  }
  async function doWipe() { await wipeVault(); await removeAllEncryptedFiles().catch(() => undefined); onWiped(); }

  const titles = {
    unlock: t('mobileUI.unlockSettings'),
    change: t('mobileUI.changePassphrase'),
    backup: t('mobileUI.backupSettings'),
    server: t('mobileUI.serverSettings'),
    delete: t('mobileUI.dangerZone'),
    about: t('mobileUI.about'),
    language: dict.language.label,
  };
  const icon = (name: NativeIconName) => <Icon name={name} size="lg" color={colors.secondary} />;
  const autoLockLabel = (minutes: AutoLockMinutes) => minutes === 0 ? dict.settings.never : tp(dict.settings.minutes, minutes);
  const cancelVerification = () => {
    setStepUpAction(null); setStepUpPass(''); setStepUpCode(''); setStepUpError('');
  };
  let accountStatus = t('mobileUI.localOnly');
  if (apiConfigured) accountStatus = t(signedIn ? 'mobileUI.accountConnectedLocal' : 'mobileUI.accountSignedOutLocal');

  return (
    <>
      <AppPage testID="settings-screen">
        <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'center' }}>
          <GhostBrandMark />
          <View style={{ flex: 1 }}>
            <Text style={[textStyle.title, { color: colors.text }]}>My Secret</Text>
            <Text style={[textStyle.helper, { color: colors.muted }]}>{accountStatus}</Text>
          </View>
        </View>

        <Group title={t('mobileUI.vaultSettings')}>
          <SettingsRow testID="lock-now-button" icon={icon('lock')} label={t('mobileUI.lockNow')} onPress={onLock} navigation={false} />
          {onViewArchive && <><Rule leading /><SettingsRow testID="view-archive-button" icon={icon('archive')} label={dict.shell.archived} onPress={onViewArchive} navigation /></>}
          <Rule leading />
          <SettingsRow testID="view-trash-button" icon={icon('trash')} label={dict.shell.trash} onPress={onViewTrash} navigation />
        </Group>

        <Group title={t('mobileUI.securityAccountSettings')}>
          <SettingsRow testID="settings-unlock" icon={icon('unlock')} label={t('mobileUI.unlockSettings')} value={autoLockLabel(autoLock)} onPress={() => setPanel('unlock')} navigation />
          <Rule leading />
          <SettingsRow testID="settings-passphrase" icon={icon('credentials')} label={t('mobileUI.changePassphrase')} onPress={() => setPanel('change')} navigation />
          <Rule leading />
          {apiConfigured && !signedIn && <><SettingsRow testID="settings-sign-in" icon={icon('enter')} label={dict.signin.signIn} onPress={onSignIn} navigation /><Rule leading /></>}
          <SettingsRow testID="security-center-button" icon={icon('security')} label={dict.security.title} onPress={onViewSecurity} navigation />
          {onOpen && <>
            <Rule leading />
            <SettingsRow testID="settings-sharing" icon={icon('share')} label={t('mobileUI.sharing')} onPress={() => onOpen('Shares')} navigation />
            <Rule leading />
            <SettingsRow testID="settings-family" icon={icon('person')} label={t('mobileUI.familyPlan')} onPress={() => onOpen('Family')} navigation />
          </>}
        </Group>

        <Group title={t('mobileUI.dataBackupSettings')}>
          <SettingsRow testID="settings-backup" icon={icon('export')} label={t('mobileUI.backupSettings')} onPress={() => setPanel('backup')} navigation />
        </Group>

        <Group title={dict.settings.preferencesTitle}>
          {onAppearance && <><SettingsRow testID="settings-appearance" icon={icon('appearance')} label={dict.theme.label} value={dict.theme[preference]} onPress={onAppearance} navigation /><Rule leading /></>}
          <SettingsRow testID="settings-language" icon={icon('language')} label={dict.language.label} value={locale === 'en' ? 'English' : 'Tiếng Việt'} onPress={() => setPanel('language')} navigation />
        </Group>

        <Group title={t('mobileUI.advanced')}>
          {__DEV__ && <><SettingsRow testID="settings-server" icon={icon('server')} label={t('mobileUI.serverSettings')} value={apiConfigured ? t('mobileUI.connected') : t('mobileUI.notConnected')} onPress={() => { setServerDraft(apiBaseUrl); setPanel('server'); }} navigation /><Rule leading /></>}
          <SettingsRow testID="settings-about" icon={icon('info')} label={t('mobileUI.about')} onPress={() => setPanel('about')} navigation />
          <Rule leading />
          <SettingsRow testID="settings-delete" icon={icon('trash')} label={t('mobileUI.dangerZone')} destructive onPress={() => setPanel('delete')} navigation />
        </Group>
      </AppPage>

      <BottomSheet
        visible={panel !== null}
        title={stepUpAction ? t('security.stepUpTitle') : panel ? titles[panel] : ''}
        onClose={stepUpBusy || backupBusy ? () => undefined : closePanel}
        testID="settings-panel"
      >
        {stepUpAction ? (
          <FormSection description={t('security.stepUpBody')}>
            <FieldGroup>
              <AppTextField label={t('security.stepUpPassphraseLabel')} testID="stepup-passphrase" secureTextEntry revealable value={stepUpPass} onChangeText={setStepUpPass} autoCapitalize="none" autoCorrect={false} />
              {requiresAccountVerification && <AppTextField label={t('security.stepUpTotpLabel')} testID="stepup-totp-code" value={stepUpCode} onChangeText={setStepUpCode} autoCapitalize="none" autoCorrect={false} keyboardType="number-pad" />}
            </FieldGroup>
            {!!stepUpError && <InlineError testID="stepup-error">{stepUpError}</InlineError>}
            <AppButton testID="stepup-confirm" label={t('security.confirm')} loading={stepUpBusy} onPress={() => void submitStepUp()} />
            <AppButton testID="stepup-cancel" variant="secondary" label={dict.common.cancel} disabled={stepUpBusy} onPress={cancelVerification} />
          </FormSection>
        ) : null}

        {!stepUpAction && panel === 'unlock' && (
          <>
            <PageSection title={dict.settings.autoLockTitle} description={dict.settings.autoLockBody}>
              <Group>
                {AUTO_LOCK_CHOICES.map((minutes, index) => (
                  <React.Fragment key={minutes}>
                    {index > 0 && <Rule />}
                    <SettingsRow
                      testID={`settings-autolock-${minutes}`}
                      label={autoLockLabel(minutes)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: minutes === autoLock }}
                      selected={minutes === autoLock}
                      onPress={() => onAutoLockChange(minutes)}
                    />
                  </React.Fragment>
                ))}
              </Group>
              {persistenceError && <InlineError testID="autolock-save-error">{t('mobileUI.settingsSaveFailed')}</InlineError>}
            </PageSection>
            <FormSection title={t('mobileUI.biometricSettings')} description={t(device?.enrolled ? 'mobileUI.biometricOn' : device?.available ? 'mobileUI.biometricHint' : 'mobileUI.biometricUnavailable', bioName)}>
              {device?.enrolled ? (
                <AppButton testID="disable-biometric-button" variant="secondary" label={t('mobileUI.biometricDisable', bioName)} loading={bioBusy} onPress={() => void disableBiometric()} />
              ) : device?.available ? (
                <>
                  <AppTextField label={dict.settings.current} testID="biometric-passphrase" secureTextEntry revealable value={bioPass} onChangeText={setBioPass} autoCapitalize="none" autoCorrect={false} />
                  <AppButton testID="enable-biometric-settings-button" label={t('mobileUI.biometricEnable', bioName)} disabled={!bioPass} loading={bioBusy} onPress={() => void enableBiometric()} />
                </>
              ) : null}
              {!!bioMessage && <Text testID="biometric-message" accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.secondary }]}>{bioMessage}</Text>}
            </FormSection>
          </>
        )}

        {!stepUpAction && panel === 'change' && (
          <FormSection>
            <FieldGroup>
              <AppTextField label={dict.settings.newPassphrase} testID="new-passphrase" secureTextEntry revealable value={newPass} onChangeText={setNewPass} autoCapitalize="none" autoCorrect={false} error={changeError === dict.settings.tooShort ? changeError : undefined} />
              <AppTextField label={dict.settings.confirm} testID="confirm-new-passphrase" secureTextEntry revealable value={newConfirm} onChangeText={setNewConfirm} autoCapitalize="none" autoCorrect={false} error={changeError === dict.settings.mismatch ? changeError : undefined} />
            </FieldGroup>
            {changeError && changeError !== dict.settings.tooShort && changeError !== dict.settings.mismatch ? <InlineError testID="change-passphrase-error">{changeError}</InlineError> : null}
            {changeOk && <Text accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.okText }]}>{t('mobileUI.saved')}</Text>}
            <AppButton testID="change-passphrase-button" label={dict.settings.change} onPress={requestChangePassphrase} />
          </FormSection>
        )}

        {!stepUpAction && panel === 'backup' && (
          <FormSection description={t('mobileUI.backupHelp')}>
            <Text style={[textStyle.helper, { color: colors.muted }]}>{t('mobileUI.backupLocalFiles')}</Text>
            {backupError ? <InlineError testID="backup-export-error">{backupError}</InlineError> : null}
            <AppButton testID="export-backup-file" label={t('mobileUI.exportBackupFile')} icon="export" loading={backupBusy} onPress={() => requestExport('export-file')} />
            <AppButton testID="export-encrypted-button" label={t('mobileUI.exportBackup')} variant="secondary" icon="copy" disabled={backupBusy} onPress={() => requestExport('export')} />
            {backupCopied && <Text accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.okText }]}>{t('mobileUI.backupCopied')}</Text>}
          </FormSection>
        )}

        {!stepUpAction && panel === 'server' && (
          <FormSection description={t('mobileUI.serverHelp')}>
            <FieldGroup>
              <AppTextField label={t('mobileUI.serverURL')} testID="api-base-url" placeholder="https://vault.example.com/api" value={serverDraft} onChangeText={value => { setServerDraft(value); setServerSaved(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <AppTextField label={t('mobileUI.webAppURL')} testID="share-web-origin" placeholder="https://vault.example.com" value={webOrigin} onChangeText={setWebOrigin} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            </FieldGroup>
            {serverError ? <InlineError>{serverError}</InlineError> : null}
            <AppButton testID="save-api-server" label={t('mobileUI.saveServer')} onPress={() => void saveApiBaseUrl(serverDraft.trim())} />
            {serverSaved && <Text accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.okText }]}>{t('mobileUI.saved')}</Text>}
          </FormSection>
        )}

        {!stepUpAction && panel === 'delete' && (
          <FormSection description={t('mobileUI.dangerHelp')}>
            <AppButton testID="wipe-vault-button" variant="destructive" label={t('mobileUI.dangerZone')} onPress={() => Alert.alert(dict.settings.wipeTitle, dict.settings.wipeBody, [{ text: dict.common.cancel, style: 'cancel' }, { text: dict.common.delete, style: 'destructive', onPress: requestWipe }])} />
          </FormSection>
        )}

        {!stepUpAction && panel === 'about' && (
          <PageSection description={t('mobileUI.aboutBody')}>
            <Group><SettingsRow label={dict.settings.encryption} value={dict.settings.encryptionValue} /></Group>
          </PageSection>
        )}

        {!stepUpAction && panel === 'language' && (
          <Group>
            {(['en', 'vi'] as const).map((value, index) => (
              <React.Fragment key={value}>
                {index > 0 && <Rule />}
                <SettingsRow testID={`settings-language-${value}`} label={value === 'en' ? 'English' : 'Tiếng Việt'} accessibilityRole="radio" accessibilityState={{ checked: locale === value }} selected={locale === value} onPress={() => { setLocale(value); closePanel(); }} />
              </React.Fragment>
            ))}
          </Group>
        )}
      </BottomSheet>
    </>
  );
}
