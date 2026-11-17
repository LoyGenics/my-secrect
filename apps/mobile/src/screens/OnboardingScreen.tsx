import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Field from '../components/Field';
import StrengthMeter from '../components/StrengthMeter';
import { colors, styles } from '../theme';
import { createVault } from '../vault';

/** Step 0: create passphrase. Step 1: recovery key shown ONCE. Step 2: done. */
export default function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    setError('');
    if (pass.length < 8) { setError('Passphrase must be at least 8 characters.'); return; }
    if (pass !== confirm) { setError('Passphrases do not match.'); return; }
    setBusy(true);
    try {
      const { recoveryKey: key } = await createVault(pass);
      setRecoveryKey(key); setPass(''); setConfirm(''); setStep(1);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create the vault.'); }
    finally { setBusy(false); }
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingTop: 64 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>my-secrect</Text>
      <Text style={styles.subtitle}>Create your local vault. Everything is encrypted on this device with Argon2id + XChaCha20-Poly1305.</Text>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 20 }}>
        {['Create passphrase', 'Save recovery key', 'Done'].map((label, i) => (
          <View key={label} style={{ flex: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 4, backgroundColor: i === step ? colors.accentSoft : colors.card, alignItems: 'center' }}>
            <Text style={{ color: i === step ? '#C7D2FE' : colors.muted, fontSize: 11, fontWeight: '600', textAlign: 'center' }}>{i + 1}. {label}</Text>
          </View>
        ))}
      </View>
      {step === 0 && (
        <View style={{ marginTop: 20 }}>
          <Field label="Master passphrase" testID="master-passphrase" placeholder="At least 8 characters" secureTextEntry value={pass} onChangeText={setPass} autoCapitalize="none" autoCorrect={false} />
          <Field label="Confirm passphrase" testID="confirm-passphrase" placeholder="Repeat your passphrase" secureTextEntry value={confirm} onChangeText={setConfirm} autoCapitalize="none" autoCorrect={false} />
          <StrengthMeter password={pass} />
          {error ? <Text testID="onboarding-error" style={[styles.error, { marginBottom: 12 }]}>{error}</Text> : null}
          <Pressable testID="create-vault-button" accessibilityLabel="Create vault" accessibilityRole="button" disabled={busy} onPress={() => void handleCreate()} style={[styles.primaryButton, busy ? { opacity: 0.6 } : null]}>
            <Text style={styles.primaryButtonText}>{busy ? 'Creating vault…' : 'Create vault'}</Text>
          </Pressable>
          <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 16 }}>Prototype: Argon2id + XChaCha20-Poly1305 via libsodium. Not audited — do not treat as production-ready.</Text>
        </View>
      )}
      {step === 1 && (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}><Text style={{ fontWeight: '700' }}>Save this recovery key — it is shown only once.</Text> It is the only way back in if you forget your passphrase. It is never stored on this device in readable form.</Text>
          <View testID="recovery-key" accessibilityLabel="Recovery key" style={{ marginTop: 14, backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 14 }}>
            <Text selectable style={{ color: colors.text, fontFamily: 'monospace', fontSize: 14, lineHeight: 20 }}>{recoveryKey}</Text>
          </View>
          <Pressable testID="copy-recovery-key" accessibilityLabel="Copy recovery key" accessibilityRole="button" style={[styles.ghostButton, { marginTop: 12 }]} onPress={() => { void Clipboard.setStringAsync(recoveryKey); setCopied(true); }}>
            <Text style={styles.ghostButtonText}>{copied ? 'Copied to clipboard' : 'Copy recovery key'}</Text>
          </Pressable>
          <Pressable testID="recovery-ack" accessibilityLabel="I have saved my recovery key somewhere safe" accessibilityRole="checkbox" accessibilityState={{ checked: ack }} onPress={() => setAck((v) => !v)} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 16 }}>
            <Text style={{ fontSize: 20, color: ack ? colors.accent : colors.faint }}>{ack ? '☑' : '☐'}</Text>
            <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>I have saved my recovery key somewhere safe.</Text>
          </Pressable>
          <Pressable testID="recovery-done-button" accessibilityLabel="Done" accessibilityRole="button" disabled={!ack} onPress={() => setStep(2)} style={[styles.primaryButton, { marginTop: 16 }, !ack ? { opacity: 0.5 } : null]}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>
      )}
      {step === 2 && (
        <View style={{ marginTop: 20, alignItems: 'center' }}>
          <Text style={{ fontSize: 48 }}>✓</Text>
          <Text style={{ color: colors.text, fontSize: 16, textAlign: 'center', marginTop: 8 }}>Your vault is created and unlocked. Add your first item to get started.</Text>
          <Pressable testID="open-vault-button" accessibilityLabel="Open vault" accessibilityRole="button" style={[styles.primaryButton, { marginTop: 20, alignSelf: 'stretch' }]} onPress={onDone}>
            <Text style={styles.primaryButtonText}>Open vault</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}
