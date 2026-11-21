import React, { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Keyboard, StyleSheet, Text, View, type TextInput } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon } from '../../../../packages/ui/src/native';
import AppTextField from '../components/Field';
import { AppButton, Group, InlineError, SettingsRow } from '../components/mobile-ui';
import { AuthLayout } from '../components/AuthLayout';
import { KeyGrid } from '../components/KeyGrid';
import StrengthMeter from '../components/StrengthMeter';
import { useMobileTheme } from '../theme';
import { radius, space, textStyle } from '../ui/tokens';
import { recoveryKeyFileText, saveRecoveryKeyFile } from '../utils/recoveryKeyFile';
import { matchesRecoveryKeyEnding, RECOVERY_REVIEW_LENGTH } from '../utils/authInput';
import { createVault } from '../vault';
import RestoreBackupPanel from './RestoreBackupPanel';

export default function OnboardingScreen({ onDone, onRestored }: { onDone: () => void; onRestored?: () => void }) {
  const { dict, t } = useTranslation();
  const { onboarding, mobileAuth: auth } = dict;
  const { colors, styles } = useMobileTheme();
  const confirmation = useRef<TextInput>(null);
  const [restoring, setRestoring] = useState(false);
  const [step, setStep] = useState<'create' | 'save' | 'done'>('create');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passphraseError, setPassphraseError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [ack, setAck] = useState(false);
  const [review, setReview] = useState(false);
  const [ending, setEnding] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Remove the value from the rendered tree while the app is away. The
    // user can reveal it again on this step when they return.
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') setKeyVisible(false);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (restoring) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      if (step !== 'save') return false;
      if (review) {
        setReview(false);
        setEnding('');
        setReviewError('');
      }
      // Leaving this step would discard the only displayed copy of the key.
      return true;
    });
    return () => back.remove();
  }, [busy, restoring, review, step]);

  async function handleCreate() {
    if (busy) return;
    setError('');
    setPassphraseError(passphrase.length < 8 ? onboarding.tooShort : '');
    setConfirmError(passphrase !== confirm ? onboarding.mismatch : '');
    if (passphrase.length < 8 || passphrase !== confirm) return;
    setBusy(true);
    Keyboard.dismiss();
    try {
      const { recoveryKey } = await createVault(passphrase);
      setRecoveryKey(recoveryKey);
      setKeyVisible(AppState.currentState === 'active' || AppState.currentState === null);
      setPassphrase('');
      setConfirm('');
      setStep('save');
    } catch {
      setError(onboarding.createFailed);
    } finally {
      setBusy(false);
    }
  }

  async function downloadKey() {
    try {
      await saveRecoveryKeyFile(recoveryKeyFileText(recoveryKey, auth.keyFileHeading, auth.keyFileWarning));
      setError('');
    } catch {
      setError(auth.downloadKeyFailed);
    }
  }

  async function copyKey() {
    try {
      await Clipboard.setStringAsync(recoveryKey);
      setCopied(true);
      setError('');
    } catch {
      setError(auth.keyCopyFailed);
    }
  }

  function completeReview() {
    if (!ack || !matchesRecoveryKeyEnding(recoveryKey, ending)) {
      setReviewError(auth.keyMismatch);
      return;
    }
    Keyboard.dismiss();
    setRecoveryKey('');
    setEnding('');
    setCopied(false);
    setReview(false);
    setReviewError('');
    setStep('done');
  }

  if (restoring && onRestored) {
    return (
      <AuthLayout title={auth.backupTitle} subtitle={dict.restore.lede}>
        <RestoreBackupPanel onRestored={onRestored} onCancel={() => setRestoring(false)} />
      </AuthLayout>
    );
  }

  const stepIndex = step === 'create' ? 0 : step === 'save' ? 1 : 2;
  const title = step === 'create' ? t('mobileAuth.createTitle') : step === 'save' ? (review ? auth.reviewKey : onboarding.steps.save) : onboarding.readyTitle;
  const subtitle = step === 'create' ? onboarding.lede : step === 'save' ? (review ? auth.reviewKeyBody : onboarding.saveBody) : onboarding.readyBody;
  const leaveReview = () => { setReview(false); setKeyVisible(true); setEnding(''); setReviewError(''); };
  const matches = !!confirm && confirm === passphrase;

  const actions = step === 'create' ? <View style={local.actions}>
    <AppButton testID="create-vault-button" label={busy ? onboarding.creating : onboarding.createVault}
      loading={busy} onPress={() => void handleCreate()} />
    {onRestored && <AppButton testID="restore-from-backup-button" label={onboarding.restoreFromBackup}
      variant="text" disabled={busy} onPress={() => { Keyboard.dismiss(); setRestoring(true); }} />}
  </View> : step === 'save' && !review ? <View style={local.actions}>
    <AppButton testID="recovery-review-button" label={auth.continue} disabled={!ack} accessibilityLabel={auth.continue}
      onPress={() => { setKeyVisible(false); setReview(true); }} />
    {!ack && <Text testID="recovery-continue-reason" style={[styles.small, local.center]}>{auth.tickToContinue}</Text>}
  </View> : step === 'save' ? <View style={local.actions}>
    <AppButton testID="recovery-done-button" label={onboarding.done}
      disabled={ending.length !== RECOVERY_REVIEW_LENGTH} onPress={completeReview} />
    <AppButton testID="recovery-review-back" label={auth.showKey} variant="text" onPress={leaveReview} />
  </View> : <AppButton testID="open-vault-button" label={onboarding.openVault} onPress={onDone} />;

  return (
    <AuthLayout title={title} subtitle={subtitle} actions={actions}
      step={{ index: stepIndex, eyebrow: t('mobileAuth.stepShort', stepIndex + 1, 3), labels: [auth.stepPassphrase, auth.stepRecoveryKey, auth.stepReady] }}
      onBack={step === 'save' && review ? leaveReview : undefined} backLabel={auth.showKey}>
      {step === 'create' && <>
        <AppTextField flush revealable label={onboarding.passphrase} testID="master-passphrase"
          placeholder={onboarding.passphrasePlaceholder} value={passphrase}
          onChangeText={(value) => { setPassphrase(value); setPassphraseError(''); setConfirmError(''); }}
          error={passphraseError || undefined} disabled={busy} autoCapitalize="none" autoCorrect={false}
          autoComplete="off" returnKeyType="next" onSubmitEditing={() => confirmation.current?.focus()} />
        <StrengthMeter password={passphrase} />
        <AppTextField flush revealable ref={confirmation} label={onboarding.confirm} testID="confirm-passphrase"
          placeholder={onboarding.confirmPlaceholder} value={confirm}
          onChangeText={(value) => { setConfirm(value); setConfirmError(''); }}
          error={confirmError || undefined} disabled={busy} autoCapitalize="none" autoCorrect={false}
          autoComplete="off" returnKeyType="go" onSubmitEditing={() => void handleCreate()} />
        {matches && !confirmError && <View style={local.match} accessibilityLiveRegion="polite">
          <Icon name="success" size="md" color={colors.successText} />
          <Text style={[textStyle.control, { color: colors.successText }]}>{auth.passphrasesMatch}</Text>
        </View>}
        {!!error && <InlineError testID="onboarding-error">{error}</InlineError>}
      </>}

      {step === 'save' && !review && <>
        {keyVisible ? <KeyGrid testID="recovery-key" value={recoveryKey} />
          : <View testID="recovery-key" style={[local.hiddenKey, { backgroundColor: colors.sunken }]}>
            <Text style={styles.small}>{auth.keyHidden}</Text>
          </View>}
        <View style={local.keyActions}>
          <AppButton testID="recovery-key-visibility" label={keyVisible ? dict.common.hide : dict.common.show}
            accessibilityLabel={keyVisible ? auth.hideKey : auth.showKey}
            icon={keyVisible ? 'hide' : 'show'} variant="secondary" size="compact" onPress={() => setKeyVisible((visible) => !visible)} />
          <AppButton testID="copy-recovery-key" label={copied ? onboarding.copied : t('mobileUI.copy')} accessibilityLabel={onboarding.copyKey}
            icon="copy" variant="secondary" size="compact" onPress={() => void copyKey()} />
          <AppButton testID="download-recovery-key" label={auth.downloadKey} icon="export" variant="secondary" size="compact"
            onPress={() => void downloadKey()} />
        </View>
        <Text style={styles.small}>{auth.keyFileNote}</Text>
        {!!error && <InlineError testID="onboarding-error">{error}</InlineError>}
        <Group>
          <SettingsRow testID="recovery-ack" label={onboarding.ack} accessibilityRole="checkbox"
            accessibilityState={{ checked: ack }} selected={ack} onPress={() => setAck((checked) => !checked)} />
        </Group>
      </>}

      {step === 'save' && review && (
        <AppTextField flush secureTextEntry label={auth.keyEnd} testID="recovery-key-review" value={ending}
          error={reviewError || undefined} maxLength={RECOVERY_REVIEW_LENGTH}
          onChangeText={(value) => { setEnding(value); setReviewError(''); }}
          autoCapitalize="none" autoCorrect={false} autoComplete="off" returnKeyType="done" onSubmitEditing={completeReview} />
      )}
    </AuthLayout>
  );
}

const local = StyleSheet.create({
  actions: { gap: space[2] },
  center: { textAlign: 'center' },
  match: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  hiddenKey: { borderRadius: radius.keyCell, padding: space[4], alignItems: 'center' },
  keyActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
});
