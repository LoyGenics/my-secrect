import React, { useEffect, useState } from 'react';
import { BackHandler, Keyboard, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createTranslator } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { illustrations } from '../../../../packages/ui/src/native';
import type { Biometry } from '../../modules/device-key';
import AppTextField from '../components/Field';
import { AppButton, FieldGroup, InlineError, Progress } from '../components/mobile-ui';
import { AuthLayout } from '../components/soft';
import { space } from '../ui/tokens';
import {
  enableDeviceUnlock, getDeviceUnlockState, getStorageError, unlockVault, unlockWithDeviceKey, unlockWithRecoveryKey,
  type DeviceUnlockFailure, type DeviceUnlockState,
} from '../vault';

const defaultTranslation = createTranslator('en').t;
const BIOMETRIC_OFFER_PREFERENCE = 'my-secrect:biometric-enrollment-offer';

export function biometryName(biometry: Biometry | undefined, t = defaultTranslation): string {
  if (biometry === 'faceId') return 'Face ID';
  if (biometry === 'touchId') return 'Touch ID';
  if (biometry === 'fingerprint') return t('mobileAuth.fingerprint');
  return t('mobileAuth.bioGeneric');
}

export function deviceUnlockMessage(code: DeviceUnlockFailure, name: string, t = defaultTranslation): string {
  switch (code) {
    case 'USER_CANCEL': return t('mobileAuth.bioCancelled');
    case 'AUTH_FAILED': return t('mobileAuth.bioAuthFailed', name);
    case 'LOCKOUT': return t('mobileAuth.bioLockout', name);
    case 'NOT_ENROLLED': return t('mobileAuth.bioNotEnrolled', name);
    case 'NOT_AVAILABLE': return t('mobileAuth.bioUnavailable', name);
    case 'KEY_INVALIDATED': return t('mobileAuth.bioInvalidated', name);
    case 'CORRUPT': return t('mobileAuth.bioCorrupt', name);
    case 'NOT_SET_UP': return t('mobileAuth.bioNotSetUp', name);
    case 'WRONG_PASSPHRASE': return t('lock.wrongPassphrase');
    case 'STORAGE': return t('mobileAuth.vaultStorageError');
  }
}

type UnlockMode = 'biometric' | 'passphrase' | 'recovery';

export default function LockScreen({ onUnlocked, accountJustSignedIn = false }: {
  onUnlocked: () => void;
  accountJustSignedIn?: boolean;
}) {
  const { dict, t } = useTranslation();
  const { lock, mobileAuth: auth } = dict;
  const [mode, setMode] = useState<UnlockMode | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceUnlockState>();
  const [storageError, setStorageError] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [offer, setOffer] = useState(false);
  const [offerError, setOfferError] = useState('');

  const name = biometryName(device?.biometry, t);
  const unlockWithBiometrics = t('mobileAuth.bioUnlock', name);
  const enableBiometrics = t('mobileAuth.bioEnable', name);
  const biometricAvailable = Boolean(device?.enrolled && device.available);
  const useRecovery = mode === 'recovery';
  let subtitle = auth.unlockPassphraseBody;
  if (accountJustSignedIn) subtitle = auth.accountUnlockedTransition;
  else if (useRecovery) subtitle = auth.unlockRecoveryBody;
  else if (biometricAvailable) subtitle = auth.unlockBiometricBody;

  useEffect(() => {
    let active = true;
    void Promise.all([
      getDeviceUnlockState().catch(() => undefined),
      AsyncStorage.getItem(BIOMETRIC_OFFER_PREFERENCE).catch(() => null),
    ]).then(([state, offerPreference]) => {
      if (!active) return;
      setDevice(state);
      setStorageError(Boolean(getStorageError()));
      setDeclined(offerPreference === 'declined');
      setMode(state?.enrolled && state.available ? 'biometric' : 'passphrase');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy || offer) return true;
      if (mode === 'passphrase' && biometricAvailable) setMode('biometric');
      else if (mode === 'recovery') setMode('passphrase');
      else return false;
      setSecret('');
      setError('');
      return true;
    });
    return () => back.remove();
  }, [biometricAvailable, busy, mode, offer]);

  function choose(next: UnlockMode) {
    setMode(next);
    setSecret('');
    setError('');
  }

  function finish() {
    setSecret('');
    setOffer(false);
    setOfferError('');
    onUnlocked();
  }

  async function unlockWithSecret() {
    if (busy) return;
    if (!secret || (useRecovery && !secret.trim())) {
      setError(useRecovery ? dict.restore.enterRecovery : auth.enterPassphrase);
      return;
    }
    setError('');
    setBusy(true);
    Keyboard.dismiss();
    try {
      const unlocked = useRecovery ? await unlockWithRecoveryKey(secret.trim()) : await unlockVault(secret);
      if (!unlocked) {
        const storageFailed = Boolean(getStorageError());
        setStorageError(storageFailed);
        if (!storageFailed) setError(useRecovery ? lock.wrongRecovery : lock.wrongPassphrase);
        return;
      }
      const state = await getDeviceUnlockState().catch(() => undefined);
      setDevice(state);
      setSecret('');
      if (!declined && state?.available && !state.enrolled) {
        setOffer(true);
      } else {
        finish();
      }
    } catch {
      setStorageError(true);
    } finally {
      setBusy(false);
    }
  }

  async function unlockBiometric() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await unlockWithDeviceKey(unlockWithBiometrics);
      if (result.ok) {
        finish();
        return;
      }
      choose('passphrase');
      setError(deviceUnlockMessage(result.code, name, t));
      const state = await getDeviceUnlockState().catch(() => undefined);
      setDevice(state);
    } catch {
      choose('passphrase');
      setStorageError(true);
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    if (busy) return;
    setOfferError('');
    setBusy(true);
    try {
      const result = await enableDeviceUnlock(enableBiometrics);
      if (result.ok) finish();
      else setOfferError(result.code === 'USER_CANCEL' ? t('mobileAuth.bioNotEnabled', name) : t('mobileAuth.bioEnableFailed', name));
    } catch {
      setOfferError(t('mobileAuth.bioEnableFailed', name));
    } finally {
      setBusy(false);
    }
  }

  function skipOffer() {
    if (busy) return;
    setDeclined(true);
    void AsyncStorage.setItem(BIOMETRIC_OFFER_PREFERENCE, 'declined').catch(() => undefined);
    finish();
  }

  if (offer) {
    return (
      <AuthLayout title={t('mobileAuth.bioOffer', name)} subtitle={t('mobileAuth.bioBody', name)}>
        {!!offerError && <InlineError testID="enable-biometric-error">{offerError}</InlineError>}
        <View style={{ gap: space[3] }}>
          <AppButton label={enableBiometrics} icon="security" testID="enable-biometric-button" loading={busy} onPress={() => void enable()} />
          <AppButton label={auth.bioNotNow} variant="secondary" testID="skip-biometric-button" disabled={busy} onPress={skipOffer} />
        </View>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={lock.status} subtitle={subtitle} art={illustrations.splash}>
      {storageError && <InlineError testID="storage-error">{auth.vaultStorageError}</InlineError>}
      {mode === null && <Progress testID="unlock-loading" label={dict.common.loading} />}
      {mode === 'biometric' && (
        <View style={{ gap: space[3] }}>
          <AppButton label={unlockWithBiometrics} icon="security" testID="biometric-button" loading={busy} onPress={() => void unlockBiometric()} />
          <AppButton label={lock.usePassphrase} variant="secondary" testID="unlock-passphrase-option" disabled={busy}
            onPress={() => choose('passphrase')} />
          <AppButton label={lock.useRecoveryKey} variant="text" testID="toggle-recovery" disabled={busy}
            onPress={() => choose('recovery')} />
        </View>
      )}
      {(mode === 'passphrase' || mode === 'recovery') && (
        <FieldGroup>
          <AppTextField key={mode} flush revealable label={useRecovery ? lock.recoveryKey : lock.passphrase}
            testID={useRecovery ? 'recovery-key-input' : 'master-passphrase'}
            leadingIcon={useRecovery ? 'recovery' : 'lock'} placeholder={useRecovery ? lock.recoveryPlaceholder : lock.passphrase}
            value={secret} onChangeText={(value) => { setSecret(value); setError(''); }}
            disabled={busy} autoCapitalize="none" autoCorrect={false} autoComplete="off" returnKeyType="go"
            onSubmitEditing={() => void unlockWithSecret()} />
          {!!error && <InlineError testID="lock-error">{error}</InlineError>}
          <View style={{ gap: space[3] }}>
            <AppButton label={busy ? lock.working : useRecovery ? lock.unlockWithRecovery : lock.unlock} icon="unlock"
              testID="unlock-button" loading={busy} onPress={() => void unlockWithSecret()} />
            {biometricAvailable && !useRecovery && <AppButton label={unlockWithBiometrics} icon="security"
              variant="secondary" testID="biometric-button" disabled={busy} onPress={() => choose('biometric')} />}
            <AppButton label={useRecovery ? lock.usePassphrase : lock.useRecoveryKey} variant="text" testID="toggle-recovery"
              disabled={busy} onPress={() => choose(useRecovery ? 'passphrase' : 'recovery')} />
          </View>
        </FieldGroup>
      )}
    </AuthLayout>
  );
}
