import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import Field from '../components/Field';
import { colors, styles } from '../theme';
import { unlockVault, unlockWithRecoveryKey } from '../vault';

/**
 * Lock screen. Biometrics are a convenience unlock ONLY after a
 * passphrase unlock has happened in this install — this screen never
 * fakes a biometric success: if the device reports no enrolled
 * biometrics, or authentication fails/cancels, the user must type the
 * passphrase (or recovery key). Biometric unlock here re-uses the
 * in-memory session only; it cannot derive the KEK from a fingerprint.
 * Full device-protected key wrapping (Keychain/Keystore) is documented
 * in native/keychain-keystore/README.md and is not yet implemented.
 */
export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pass, setPass] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioType, setBioType] = useState('Biometrics');

  useEffect(() => {
    void (async () => {
      try {
        const enrolled = await LocalAuthentication.hasHardwareAsync();
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        setBioAvailable(enrolled && types.length > 0);
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) setBioType('Face ID');
        else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) setBioType('Fingerprint');
      } catch { setBioAvailable(false); }
    })();
  }, []);

  async function handleUnlock() {
    setError(''); setBusy(true);
    const ok = useRecovery ? (recovery.trim() ? await unlockWithRecoveryKey(recovery.trim()) : false) : pass ? await unlockVault(pass) : false;
    setBusy(false);
    if (ok) { setPass(''); setRecovery(''); setUseRecovery(false); onUnlocked(); }
    else setError(useRecovery ? 'That recovery key did not unlock the vault. Check it and try again.' : 'Wrong passphrase, or no vault exists yet.');
  }

  async function handleBiometric() {
    setError('');
    try {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock my-secrect', cancelLabel: 'Use passphrase instead', disableDeviceFallback: false });
      if (result.success) {
        // Biometrics alone cannot derive the Argon2id KEK. This build
        // therefore does NOT unlock from biometrics alone: it only
        // confirms the user is present, and still requires the
        // passphrase below. That limitation is shown to the user.
        setError(`${bioType} confirmed you are present, but this build still needs your passphrase to derive the vault key. Enter it below.`);
      } else if (result.error === 'user_cancel') {
        setError('Biometric unlock cancelled. Enter your passphrase instead.');
      } else {
        setError('Biometric unlock failed. Enter your passphrase instead.');
      }
    } catch { setError('Biometric unlock is unavailable. Enter your passphrase instead.'); }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingTop: 96 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>my-secrect</Text>
      <Text style={styles.subtitle}>Your vault is locked. Enter your passphrase to unlock.</Text>
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
        {bioAvailable && !useRecovery ? (
          <Pressable testID="biometric-button" accessibilityLabel={`Unlock with ${bioType}`} accessibilityRole="button" style={[styles.ghostButton, { marginTop: 12 }]} onPress={() => void handleBiometric()}>
            <Text style={styles.ghostButtonText}>Unlock with {bioType}</Text>
          </Pressable>
        ) : null}
        <Pressable testID="toggle-recovery" accessibilityLabel={useRecovery ? 'Use passphrase instead' : 'Unlock with a recovery key'} accessibilityRole="button" onPress={() => { setUseRecovery((v) => !v); setError(''); }} style={{ marginTop: 16, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: '#A5B4FC', fontSize: 15 }}>{useRecovery ? 'Use passphrase instead…' : 'Unlock with a recovery key…'}</Text>
        </Pressable>
        <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 12 }}>Biometrics confirm presence only in this build — the vault key is still derived from your passphrase (Argon2id). Device-protected key wrapping is a planned native step, see native/keychain-keystore/README.md.</Text>
      </View>
    </ScrollView>
  );
}
