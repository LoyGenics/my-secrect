import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { illustrations } from '../../../../packages/ui/src/native';
import { Btn, P, Rise, SoftAlert, SoftField, SoftScreen, TextButton, useReducedMotion } from '../components/soft';
import {
  enableDeviceUnlock, getDeviceUnlockState, getStorageError, unlockVault, unlockWithDeviceKey, unlockWithRecoveryKey,
  type DeviceUnlockFailure, type DeviceUnlockState,
} from '../vault';
import type { Biometry } from '../../modules/device-key';

export function biometryName(b: Biometry | undefined): string {
  return b === 'faceId' ? 'Face ID' : b === 'touchId' ? 'Touch ID' : b === 'fingerprint' ? 'fingerprint' : 'biometrics';
}

/** What to tell the user after a biometric attempt that did not unlock. Every path ends at the passphrase. */
export function deviceUnlockMessage(code: DeviceUnlockFailure, name: string): string {
  switch (code) {
    case 'USER_CANCEL': return 'Biometric unlock cancelled. Enter your passphrase.';
    case 'AUTH_FAILED': return `${name} was not recognised. Try again or enter your passphrase.`;
    case 'LOCKOUT': return `${name} is locked after too many attempts. Enter your passphrase.`;
    case 'NOT_ENROLLED': return `No ${name} is set up on this device. Enter your passphrase.`;
    case 'NOT_AVAILABLE': return `${name} is not available right now. Enter your passphrase.`;
    case 'KEY_INVALIDATED': return `Your ${name} settings changed, so ${name} unlock was turned off. Enter your passphrase; you can turn it on again right after.`;
    case 'CORRUPT': return `${name} unlock data could not be read and was removed. Enter your passphrase; you can turn it on again right after.`;
    case 'WRONG_PASSPHRASE': return 'Wrong passphrase.';
    case 'NOT_SET_UP': return `${name} unlock is not set up. Enter your passphrase.`;
    case 'STORAGE': return 'The vault on this device could not be read. Enter your passphrase.';
  }
}

/**
 * Lock screen. Passphrase or recovery key always works. Biometric unlock
 * appears only once it was turned on, and it really unwraps the Master
 * Key from a device-protected key (Secure Enclave / Keychain / Android
 * Keystore) — it never just checks presence. Any biometric failure
 * leaves the vault locked and points at the passphrase; there is no
 * other fallback. Right after a passphrase or recovery-key unlock, the
 * screen offers to turn biometric unlock on (contract §4).
 */
export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const reduced = useReducedMotion();
  const [pass, setPass] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceUnlockState | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [offer, setOffer] = useState(false);
  const [offerError, setOfferError] = useState('');

  const name = biometryName(device?.biometry);

  async function refreshDevice(): Promise<DeviceUnlockState> {
    const state = await getDeviceUnlockState();
    setDevice(state);
    setStorageError(getStorageError());
    return state;
  }
  useEffect(() => { void refreshDevice(); }, []);

  function finish() { setPass(''); setRecovery(''); setUseRecovery(false); setOffer(false); setOfferError(''); onUnlocked(); }

  async function handleUnlock() {
    setError(''); setBusy(true);
    const ok = useRecovery ? (recovery.trim() ? await unlockWithRecoveryKey(recovery.trim()) : false) : pass ? await unlockVault(pass) : false;
    if (!ok) {
      setBusy(false);
      const storage = getStorageError();
      setStorageError(storage);
      setError(storage ? 'The vault could not be opened (see above).' : useRecovery ? 'That recovery key did not unlock the vault. Check it and try again.' : 'Wrong passphrase, or no vault exists yet.');
      return;
    }
    const state = await refreshDevice();
    setBusy(false);
    if (!state.enrolled && state.available) { setPass(''); setRecovery(''); setOffer(true); }
    else finish();
  }

  async function handleBiometric() {
    setError(''); setBusy(true);
    const result = await unlockWithDeviceKey('Unlock my-secrect');
    setBusy(false);
    if (result.ok) { finish(); return; }
    setError(deviceUnlockMessage(result.code, name));
    await refreshDevice();
  }

  async function handleEnable() {
    setOfferError(''); setBusy(true);
    const result = await enableDeviceUnlock(`Turn on ${name} unlock for my-secrect`);
    setBusy(false);
    if (result.ok) finish();
    else setOfferError(result.code === 'USER_CANCEL' ? `${name} unlock was not turned on.` : `${name} unlock could not be turned on: ${deviceUnlockMessage(result.code, name)}`);
  }

  if (offer) {
    return (
      <SoftScreen art={illustrations.splash} title={`Turn on ${name} unlock?`} subtitle={`${name} will unlock this vault on this device. A copy of your Master Key is wrapped by a key that only ${name} on this device can release. Your passphrase keeps working, and is required again if ${name} settings change.`}>
        {offerError ? <SoftAlert testID="enable-biometric-error">{offerError}</SoftAlert> : null}
        <Btn testID="enable-biometric-button" primary icon="security" label={`Turn on ${name} unlock`} busy={busy} onPress={() => void handleEnable()} />
        <Btn testID="skip-biometric-button" label="Not now" disabled={busy} onPress={finish} />
      </SoftScreen>
    );
  }

  return (
    <SoftScreen
      art={illustrations.splash}
      title="Your vault is locked"
      subtitle="Enter your passphrase to unlock."
      footer={
        <Text style={{ color: P.ink3, fontSize: 12, lineHeight: 17, marginTop: 16, textAlign: 'center' }}>
          {device?.enrolled
            ? `${name} releases a copy of your Master Key held by a device-protected key on this phone. Your passphrase always works.`
            : 'Biometric unlock is off. You can turn it on right after unlocking with your passphrase or recovery key.'}
        </Text>
      }
    >
      {storageError ? (
        <SoftAlert testID="storage-error">
          The vault storage on this device could not be opened: {storageError}. Nothing was deleted; data that was not moved yet is still in the old storage. Restart the app to retry.
        </SoftAlert>
      ) : null}
      <Rise index={0} reduced={reduced}>
        {useRecovery ? (
          <SoftField label="Recovery key" testID="recovery-key-input" icon="recovery" placeholder="Paste your recovery key" value={recovery} onChangeText={setRecovery} autoCapitalize="none" autoCorrect={false} />
        ) : (
          <SoftField label="Master passphrase" testID="master-passphrase" icon="lock" placeholder="Master passphrase" secureTextEntry value={pass} onChangeText={setPass} autoCapitalize="none" autoCorrect={false} />
        )}
      </Rise>
      {error ? <SoftAlert testID="lock-error">{error}</SoftAlert> : null}
      <Rise index={1} reduced={reduced}>
        <Btn testID="unlock-button" primary icon="unlock" label={busy ? 'Unlocking…' : useRecovery ? 'Unlock with recovery key' : 'Unlock'} busy={busy} onPress={() => void handleUnlock()} />
      </Rise>
      {device?.enrolled && !useRecovery ? (
        <Btn testID="biometric-button" icon="security" label={`Unlock with ${name}`} disabled={busy} onPress={() => void handleBiometric()} />
      ) : null}
      <TextButton testID="toggle-recovery" brand label={useRecovery ? 'Use passphrase instead…' : 'Unlock with a recovery key…'} onPress={() => { setUseRecovery((v) => !v); setError(''); }} />
    </SoftScreen>
  );
}
