import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useMobileTheme } from '../theme';
import { Icon, illustrations } from '../../../../packages/ui/src/native';
import { passwordStrength } from '../utils/password';
import { createVault } from '../vault';
import { Btn, useSoftPalette, Rise, SoftAlert, SoftField, SoftScreen, useReducedMotion } from '../components/soft';
import RestoreBackupPanel from './RestoreBackupPanel';

const STEPS = ['Create passphrase', 'Save recovery key', 'Done'];

/** Step 0: create passphrase. Step 1: recovery key shown ONCE. Step 2: done. Soft light finish (components/soft.tsx). */
export default function OnboardingScreen({ onDone, onRestored }: { onDone: () => void; onRestored?: () => void }) {
  const P = useSoftPalette();
  const { colors, styles } = useMobileTheme();
  const reduced = useReducedMotion();
  const [restoring, setRestoring] = useState(false);
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

  // The backup restore panel keeps the app's themed finish.
  if (restoring && onRestored) {
    return (
      <SoftScreen art={illustrations.restore} title="Restore your vault" subtitle="Use an encrypted backup and your passphrase or recovery key.">
        <RestoreBackupPanel onRestored={onRestored} onCancel={() => setRestoring(false)} />
      </SoftScreen>
    );
  }

  const { score, label } = passwordStrength(pass);
  const meterColor = score <= 2 ? '#C9363B' : score <= 4 ? '#B7791F' : '#2F8F5B';
  const art = step === 0 ? illustrations.passphrase : step === 1 ? illustrations.recoveryKey : illustrations.success;

  return (
    <SoftScreen
      art={art}
      title={step === 0 ? "Create your vault" : step === 1 ? "Save your recovery key" : "Your vault is ready"}
    >
      <View accessibilityLabel={`Setup step ${step + 1} of 3`} style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
        {STEPS.map((name, index) => <View key={name} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: index <= step ? P.brandFill : P.line }} />)}
      </View>

      {step === 0 && (
        <View key="s0" style={{ gap: 14 }}>
          <Rise index={0} reduced={reduced}>
            <SoftField label="Master passphrase" testID="master-passphrase" icon="lock" placeholder="At least 8 characters" secureTextEntry value={pass} onChangeText={setPass} autoCapitalize="none" autoCorrect={false} />
          </Rise>
          <Rise index={1} reduced={reduced}>
            <SoftField label="Confirm passphrase" testID="confirm-passphrase" icon="lock" placeholder="Repeat your passphrase" secureTextEntry value={confirm} onChangeText={setConfirm} autoCapitalize="none" autoCorrect={false} />
          </Rise>
          <Rise index={2} reduced={reduced}>
            <View testID="strength-meter" accessibilityLabel={`Password strength: ${pass ? label : 'empty'}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: P.ink3, fontSize: 13 }}>Strength</Text>
                <Text style={{ color: P.ink, fontSize: 13, fontWeight: '600' }}>{pass ? label : '—'}</Text>
              </View>
              <View style={{ height: 8, borderRadius: 999, backgroundColor: P.line, marginTop: 6, overflow: 'hidden' }}>
                <View style={{ height: '100%', width: `${(score / 6) * 100}%`, backgroundColor: meterColor, borderRadius: 999 }} />
              </View>
            </View>
          </Rise>
          {error ? <SoftAlert testID="onboarding-error">{error}</SoftAlert> : null}
          <Rise index={3} reduced={reduced}>
            <Btn testID="create-vault-button" primary icon="shield" label={busy ? 'Creating vault…' : 'Create vault'} busy={busy} onPress={() => void handleCreate()} />
          </Rise>
          {onRestored ? (
            <Btn testID="restore-from-backup-button" icon="restore" label="Restore from backup" disabled={busy} onPress={() => setRestoring(true)} />
          ) : null}
        </View>
      )}

      {step === 1 && (
        <View key="s1" style={{ gap: 14 }}>
          <Rise index={0} reduced={reduced}>
            <Text style={{ color: P.ink, fontSize: 15, lineHeight: 22 }}><Text style={{ fontWeight: '700' }}>Save this key somewhere safe.</Text> You’ll need it if you forget your passphrase.</Text>
          </Rise>
          <Rise index={1} reduced={reduced}>
            <View testID="recovery-key" accessibilityLabel="Recovery key" style={{ backgroundColor: P.surface2, borderColor: P.line, borderWidth: 1, borderRadius: 14, padding: 14 }}>
              <Text selectable style={{ color: P.ink, fontFamily: 'Menlo', fontSize: 14, lineHeight: 20 }}>{recoveryKey}</Text>
            </View>
          </Rise>
          <Btn testID="copy-recovery-key" icon="copy" label={copied ? 'Copied to clipboard' : 'Copy recovery key'} onPress={() => { void Clipboard.setStringAsync(recoveryKey); setCopied(true); }} />
          <Pressable testID="recovery-ack" accessibilityLabel="I have saved my recovery key somewhere safe" accessibilityRole="checkbox" accessibilityState={{ checked: ack }} onPress={() => setAck((v) => !v)} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 }}>
            <View style={{ width: 24, height: 24, borderRadius: 8, borderWidth: 1.5, borderColor: ack ? P.brandFill : P.ink3, backgroundColor: ack ? P.brandFill : P.surface, alignItems: 'center', justifyContent: 'center' }}>{ack ? <Icon name="check" size="sm" color="#FFFFFF" /> : null}</View>
            <Text style={{ color: P.ink, fontSize: 15, flex: 1, lineHeight: 22 }}>I have saved my recovery key somewhere safe.</Text>
          </Pressable>
          <Btn testID="recovery-done-button" primary icon="check" label="Done" disabled={!ack} onPress={() => setStep(2)} />
        </View>
      )}

      {step === 2 && (
        <View key="s2" style={{ gap: 14 }}>
          <Rise index={1} reduced={reduced}>
            <Btn testID="open-vault-button" primary icon="unlock" label="Open vault" onPress={onDone} />
          </Rise>
        </View>
      )}
    </SoftScreen>
  );
}
