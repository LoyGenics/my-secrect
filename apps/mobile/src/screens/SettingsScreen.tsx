import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import Field from '../components/Field';
import { colors, styles } from '../theme';
import { changePassphrase, exportEncrypted, verifyPassphrase, wipeVault } from '../vault';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { SecurityApiClient } from '../../../../packages/sdk/src/security';
import { API_BASE_URL_KEY, getApiToken } from './SecurityScreen';
import { isStepUpRequired } from '../utils/stepUp';

export type AutoLockMinutes = 1 | 5 | 15 | 0;

type PendingAction = 'export' | 'change' | 'wipe';

export default function SettingsScreen({ autoLock, onAutoLockChange, onLock, onWiped, notice, setNotice, onViewTrash, onViewSecurity }: {
  autoLock: AutoLockMinutes; onAutoLockChange: (m: AutoLockMinutes) => void; onLock: () => void; onWiped: () => void;
  notice: string; setNotice: (s: string) => void; onViewTrash: () => void; onViewSecurity: () => void;
}) {
  const { t } = useTranslation();
  const [newPass, setNewPass] = useState('');
  const [newConfirm, setNewConfirm] = useState('');
  const [changeError, setChangeError] = useState('');
  const [changeOk, setChangeOk] = useState(false);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [exported, setExported] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  // Step-up state: every sensitive local action (export / change
  // passphrase / wipe) opens this panel first. See submitStepUp().
  const [stepUpAction, setStepUpAction] = useState<PendingAction | null>(null);
  const [stepUpPass, setStepUpPass] = useState('');
  const [stepUpCode, setStepUpCode] = useState('');
  const [stepUpError, setStepUpError] = useState('');
  const [stepUpBusy, setStepUpBusy] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(API_BASE_URL_KEY).then((v) => setApiBaseUrl(v ?? '')).catch(() => undefined);
  }, []);

  const apiConfigured = apiBaseUrl.trim() !== '';

  async function saveApiBaseUrl(v: string) {
    setApiBaseUrl(v);
    try { await AsyncStorage.setItem(API_BASE_URL_KEY, v); } catch { /* non-critical setting */ }
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
   * (ii) Server, only when an API base URL is configured: a TOTP code,
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
    if (apiConfigured) {
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
    try { const json = await exportEncrypted(); setExported(json); await Clipboard.setStringAsync(json); setNotice('Encrypted backup copied to clipboard. It stays encrypted — keep it safe.'); }
    catch { setNotice('Export failed.'); }
  }
  async function doChangePassphrase(verifiedOldPass: string) {
    setChangeError(''); setChangeOk(false);
    try { await changePassphrase(verifiedOldPass, newPass); setNewPass(''); setNewConfirm(''); setChangeOk(true); }
    catch (e) { setChangeError(e instanceof Error ? e.message : 'Could not change the passphrase.'); }
  }
  async function doWipe() { await wipeVault(); onWiped(); }

  const section = (title: string) => <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 24, marginBottom: 10 }}>{title}</Text>;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Text style={styles.title}>Settings</Text>
      {notice ? <Text testID="settings-notice" style={{ color: '#A5B4FC', fontSize: 14, lineHeight: 20, marginTop: 10 }}>{notice}</Text> : null}
      {stepUpAction ? (
        <View style={{ backgroundColor: colors.card, borderColor: colors.accent, borderWidth: 1, borderRadius: 12, padding: 16, marginTop: 16 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{t('security.stepUpTitle')}</Text>
          <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 }}>{t('security.stepUpBody')}</Text>
          {stepUpAction === 'export' ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 }}>{t('security.exportRequiresStepUp')}</Text> : null}
          <View style={{ marginTop: 12 }}>
            <Field label={t('security.stepUpPassphraseLabel')} testID="stepup-passphrase" placeholder="Master passphrase" secureTextEntry value={stepUpPass} onChangeText={setStepUpPass} autoCapitalize="none" autoCorrect={false} />
          </View>
          {apiConfigured ? (
            <Field label={t('security.stepUpTotpLabel')} testID="stepup-totp-code" placeholder="123456" value={stepUpCode} onChangeText={setStepUpCode} autoCapitalize="none" autoCorrect={false} keyboardType="number-pad" />
          ) : null}
          {stepUpError ? <Text testID="stepup-error" style={[styles.error, { marginBottom: 10 }]}>{stepUpError}</Text> : null}
          <View style={{ flexDirection: 'row' }}>
            <Pressable testID="stepup-confirm" accessibilityLabel={t('security.confirm')} disabled={stepUpBusy} style={[styles.primaryButton, { flex: 1, marginRight: 8 }]} onPress={() => void submitStepUp()}>
              <Text style={styles.primaryButtonText}>{t('security.confirm')}</Text>
            </Pressable>
            <Pressable testID="stepup-cancel" accessibilityLabel={t('security.cancel')} style={[styles.ghostButton, { flex: 1 }]} onPress={() => { setStepUpAction(null); setStepUpPass(''); setStepUpCode(''); setStepUpError(''); }}>
              <Text style={styles.ghostButtonText}>{t('security.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {section('Security')}
      <Pressable testID="security-center-button" accessibilityLabel={t('security.title')} accessibilityRole="button" style={styles.primaryButton} onPress={onViewSecurity}>
        <Text style={styles.primaryButtonText}>{t('security.title')}</Text>
      </Pressable>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 8 }}>Passkeys, MFA, trusted devices, sessions and recovery — account security, separate from vault unlock.</Text>
      <Field label="New passphrase" testID="new-passphrase" placeholder="At least 8 characters" secureTextEntry value={newPass} onChangeText={setNewPass} autoCapitalize="none" autoCorrect={false} />
      <Field label="Confirm new passphrase" testID="confirm-new-passphrase" placeholder="Repeat the new passphrase" secureTextEntry value={newConfirm} onChangeText={setNewConfirm} autoCapitalize="none" autoCorrect={false} />
      {changeError ? <Text testID="change-passphrase-error" style={[styles.error, { marginBottom: 10 }]}>{changeError}</Text> : null}
      {changeOk ? <Text testID="change-passphrase-ok" style={{ color: colors.ok, fontSize: 14, marginBottom: 10 }}>Passphrase changed. Your items were not re-encrypted — the same Master Key is now wrapped under the new passphrase. Your recovery key still works.</Text> : null}
      <Pressable testID="change-passphrase-button" accessibilityLabel="Change passphrase" accessibilityRole="button" style={styles.primaryButton} onPress={requestChangePassphrase}>
        <Text style={styles.primaryButtonText}>Change passphrase</Text>
      </Pressable>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 8 }}>Changing the passphrase asks you to re-enter the current one first (step-up). Export and wipe ask the same.</Text>
      <Text style={[styles.label, { marginTop: 16 }]}>Auto-lock</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {([1, 5, 15, 0] as AutoLockMinutes[]).map((m) => (
          <Pressable key={m} testID={`autolock-${m}`} accessibilityLabel={`Auto-lock ${m === 0 ? 'never' : `${m} minutes`}`} onPress={() => onAutoLockChange(m)} style={{ backgroundColor: autoLock === m ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, marginRight: 8, marginBottom: 8 }}>
            <Text style={{ color: autoLock === m ? '#FFF' : colors.text, fontWeight: '600' }}>{m === 0 ? 'Never' : `${m} min`}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>Recovery key: shown only once, when the vault was created. It cannot be displayed again. If you still have it, use it on the lock screen ("Unlock with a recovery key…").</Text>
      <Pressable testID="lock-now-button" accessibilityLabel="Lock vault now" style={[styles.ghostButton, { marginTop: 12 }]} onPress={onLock}>
        <Text style={styles.ghostButtonText}>Lock vault now</Text>
      </Pressable>
      <Pressable testID="view-trash-button" accessibilityLabel="View trash" style={[styles.ghostButton, { marginTop: 12 }]} onPress={onViewTrash}>
        <Text style={styles.ghostButtonText}>View Trash</Text>
      </Pressable>
      {section('Server (optional)')}
      <Field label="API base URL" testID="api-base-url" placeholder="https://… (empty = local-only)" value={apiBaseUrl} onChangeText={(v) => void saveApiBaseUrl(v)} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>The server never sees vault content — only ciphertext and opaque ids. Leave empty to stay local-only; the Security Center shows a not-configured state instead of fake data.</Text>
      {section('Backup & export')}
      <Pressable testID="export-encrypted-button" accessibilityLabel="Export encrypted backup" style={styles.primaryButton} onPress={requestExport}>
        <Text style={styles.primaryButtonText}>Export encrypted backup</Text>
      </Pressable>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 8 }}>The encrypted backup is copied to the clipboard as JSON. It can only be imported back into this vault. Import is in the desktop app; mobile import is not yet built — see README.</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 12 }}>Plaintext export is desktop-only — it is not offered on mobile (a plaintext export copied to the clipboard would linger in clipboard history). Use the desktop app, where it requires an explicit warning acknowledgement first.</Text>
      {exported ? (
        <View style={{ backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>Last export (first 200 characters):</Text>
          <Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'monospace', marginTop: 6 }}>{exported.slice(0, 200)}{exported.length > 200 ? '…' : ''}</Text>
        </View>
      ) : null}
      {section('Danger zone')}
      <Pressable testID="wipe-vault-button" accessibilityLabel="Delete entire vault" accessibilityRole="button" style={[styles.dangerButton, wipeArmed ? { opacity: 1 } : { opacity: 0.85 }]} onPress={() => { if (wipeArmed) { requestWipe(); } else { Alert.alert('Delete entire vault?', 'This permanently deletes the vault, every item and the keys. There is no undo. Tap the button again to confirm.', [{ text: 'Cancel', style: 'cancel', onPress: () => setWipeArmed(false) }, { text: 'Arm delete', style: 'destructive', onPress: () => setWipeArmed(true) }]); } }}>
        <Text style={styles.primaryButtonText}>{wipeArmed ? 'Tap again to permanently delete the vault' : 'Delete entire vault…'}</Text>
      </Pressable>
      <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 16 }}>my-secrect 0.1.0 · Local-first E2EE · Argon2id + XChaCha20-Poly1305 (libsodium) · Not audited, not production-ready.</Text>
    </ScrollView>
  );
}
