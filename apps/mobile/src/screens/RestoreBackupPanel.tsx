import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Field from '../components/Field';
import { colors, styles } from '../theme';
import { restoreEncrypted, getVaultStats, lockVault } from '../vault';
import { describeRestoreError } from '../../../desktop/src/components/restoreErrors';

/**
 * Fresh-device restore for mobile. No document-picker dependency is
 * installed (apps/mobile/package.json), so the backup JSON is pasted into a
 * text field. restoreEncrypted() requires empty storage, decrypts every item
 * before writing, and writes nothing on any failure. After success the vault
 * is locked again so a normal unlock is required.
 */
export default function RestoreBackupPanel({ onRestored, onCancel }: { onRestored: () => void; onCancel: () => void }) {
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError('');
    if (!json.trim()) { setError('Paste the contents of your backup file first.'); return; }
    if (!secret.trim()) { setError(mode === 'passphrase' ? 'Enter the passphrase for this backup.' : 'Enter the recovery key.'); return; }
    setBusy(true);
    try {
      await restoreEncrypted(json, mode === 'passphrase' ? { passphrase: secret } : { recoveryKey: secret });
    } catch (e) {
      setError(describeRestoreError(e).message);
      setBusy(false);
      return;
    }
    const n = getVaultStats().total;
    lockVault();
    setSecret(''); setJson('');
    setCount(n);
    setBusy(false);
  }

  if (count !== null) {
    return (
      <View testID="restore-success" style={{ marginTop: 20, alignItems: 'center' }}>
        <Text style={{ fontSize: 48 }}>✓</Text>
        <Text style={{ color: colors.text, fontSize: 16, textAlign: 'center', marginTop: 8 }}>
          Backup restored: {count} {count === 1 ? 'item' : 'items'} decrypted and saved. The vault is locked; unlock it normally.
        </Text>
        <Pressable testID="restore-continue" accessibilityRole="button" accessibilityLabel="Continue to unlock" style={[styles.primaryButton, { marginTop: 20, alignSelf: 'stretch' }]} onPress={onRestored}>
          <Text style={styles.primaryButtonText}>Continue to unlock</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22, marginBottom: 14 }}>
        Restore an encrypted backup (format version 2). Paste the backup file contents below. Nothing existing is overwritten.
      </Text>
      <Field label="Backup file contents" testID="restore-json" multiline value={json} onChangeText={(v) => { setJson(v); setError(''); }} autoCapitalize="none" autoCorrect={false} />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        {(['passphrase', 'recovery'] as const).map((m) => (
          <Pressable key={m} testID={`restore-mode-${m}`} accessibilityRole="radio" accessibilityState={{ selected: mode === m }} onPress={() => { setMode(m); setSecret(''); setError(''); }} style={[mode === m ? styles.primaryButton : styles.ghostButton, { flex: 1, minHeight: 44 }]}>
            <Text style={mode === m ? styles.primaryButtonText : styles.ghostButtonText}>{m === 'passphrase' ? 'Passphrase' : 'Recovery key'}</Text>
          </Pressable>
        ))}
      </View>
      <Field label={mode === 'passphrase' ? 'Backup passphrase' : 'Recovery key'} testID="restore-secret" secureTextEntry value={secret} onChangeText={setSecret} autoCapitalize="none" autoCorrect={false} />
      {error ? <Text testID="restore-error" accessibilityRole="alert" style={[styles.error, { marginBottom: 12 }]}>{error}</Text> : null}
      <Pressable testID="restore-submit" accessibilityRole="button" accessibilityLabel="Restore backup" disabled={busy} onPress={() => void submit()} style={[styles.primaryButton, busy ? { opacity: 0.6 } : null]}>
        <Text style={styles.primaryButtonText}>{busy ? 'Restoring…' : 'Restore backup'}</Text>
      </Pressable>
      <Pressable testID="restore-cancel" accessibilityRole="button" accessibilityLabel="Back to create vault" disabled={busy} onPress={onCancel} style={[styles.ghostButton, { marginTop: 12 }]}>
        <Text style={styles.ghostButtonText}>Back to create vault</Text>
      </Pressable>
    </View>
  );
}
