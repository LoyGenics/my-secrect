import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Field from '../components/Field';
import { colors, styles } from '../theme';
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
      <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingTop: 96 }}>
        <Text style={styles.title}>Turn on {name} unlock?</Text>
        <Text style={styles.subtitle}>{name} will unlock this vault on this device. A copy of your Master Key is wrapped by a key that only {name} on this device can release. Your passphrase keeps working, and is required again if {name} settings change.</Text>
        {offerError ? <Text testID="enable-biometric-error" style={[styles.error, { marginTop: 12 }]}>{offerError}</Text> : null}
        <Pressable testID="enable-biometric-button" accessibilityLabel={`Turn on ${name} unlock`} accessibilityRole="button" disabled={busy} onPress={() => void handleEnable()} style={[styles.primaryButton, { marginTop: 24 }, busy ? { opacity: 0.6 } : null]}>
          <Text style={styles.primaryButtonText}>Turn on {name} unlock</Text>
        </Pressable>
        <Pressable testID="skip-biometric-button" accessibilityLabel="Not now" accessibilityRole="button" disabled={busy} onPress={finish} style={[styles.ghostButton, { marginTop: 12 }]}>
          <Text style={styles.ghostButtonText}>Not now</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingTop: 96 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>my-secrect</Text>
      <Text style={styles.subtitle}>Your vault is locked. Enter your passphrase to unlock.</Text>
      {storageError ? (
        <Text testID="storage-error" style={[styles.error, { marginTop: 16 }]}>
          The vault storage on this device could not be opened: {storageError}. Nothing was deleted; data that was not moved yet is still in the old storage. Restart the app to retry.
        </Text>
      ) : null}
      <View style={{ marginTop: 24 }}>
        {useRecovery ? (
          <Field label="Recovery key" testID="recovery-key-input" placeholder="Paste your recovery key" value={recovery} onChangeText={setRecovery} autoCapitalize="none" autoCorrect={false} />
        ) : (
          <Field label="Master passphrase" testID="master-passphrase" placeholder="Master passphrase" secureTextEntry value={pass} onChangeText={setPass} autoCapitalize="none" autoCorrect={false} />
        )}
        {error ? <Text testID="lock-error" style={[styles.error, { marginBottom: 12 }]}>{error}</Text> : null}
        <Pressable testID="unlock-button" accessibilityLabel={useRecovery ? 'Unlock with recovery key' : 'Unlock'} accessibilityRole="button" disabled={busy} onPress={() => void handleUnlock()} style={[styles.primaryButton, busy ? { opacity: 0.6 } : null]}>
          <Text style={styles.primaryButtonText}>{busy ? 'Unlocking…' : useRecovery ? 'Unlock with recovery key' : 'Unlock'}</Text>
        </Pressable>
        {device?.enrolled && !useRecovery ? (
          <Pressable testID="biometric-button" accessibilityLabel={`Unlock with ${name}`} accessibilityRole="button" disabled={busy} style={[styles.ghostButton, { marginTop: 12 }]} onPress={() => void handleBiometric()}>
            <Text style={styles.ghostButtonText}>Unlock with {name}</Text>
          </Pressable>
        ) : null}
        <Pressable testID="toggle-recovery" accessibilityLabel={useRecovery ? 'Use passphrase instead' : 'Unlock with a recovery key'} accessibilityRole="button" onPress={() => { setUseRecovery((v) => !v); setError(''); }} style={{ marginTop: 16, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: '#A5B4FC', fontSize: 15 }}>{useRecovery ? 'Use passphrase instead…' : 'Unlock with a recovery key…'}</Text>
        </Pressable>
        <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 12 }}>
          {device?.enrolled
            ? `${name} releases a copy of your Master Key held by a device-protected key on this phone. Your passphrase always works.`
            : 'Biometric unlock is off. You can turn it on right after unlocking with your passphrase or recovery key.'}
        </Text>
      </View>
    </ScrollView>
  );
}
