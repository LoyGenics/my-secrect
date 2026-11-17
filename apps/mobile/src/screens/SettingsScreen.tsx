import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Field from '../components/Field';
import { colors, styles } from '../theme';
import { changePassphrase, exportEncrypted, exportPlaintext, wipeVault } from '../vault';

export type AutoLockMinutes = 1 | 5 | 15 | 0;

export default function SettingsScreen({ autoLock, onAutoLockChange, onLock, onWiped, notice, setNotice, onViewTrash }: {
  autoLock: AutoLockMinutes; onAutoLockChange: (m: AutoLockMinutes) => void; onLock: () => void; onWiped: () => void;
  notice: string; setNotice: (s: string) => void; onViewTrash: () => void;
}) {
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newConfirm, setNewConfirm] = useState('');
  const [changeError, setChangeError] = useState('');
  const [changeOk, setChangeOk] = useState(false);
  const [plainArmed, setPlainArmed] = useState(false);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [exported, setExported] = useState('');

  async function handleChangePassphrase() {
    setChangeError(''); setChangeOk(false);
    if (newPass.length < 8) { setChangeError('New passphrase must be at least 8 characters.'); return; }
    if (newPass !== newConfirm) { setChangeError('New passphrases do not match.'); return; }
    try { await changePassphrase(oldPass, newPass); setOldPass(''); setNewPass(''); setNewConfirm(''); setChangeOk(true); }
    catch (e) { setChangeError(e instanceof Error ? e.message : 'Could not change the passphrase.'); }
  }
  async function handleExportEncrypted() {
    try { const json = await exportEncrypted(); setExported(json); await Clipboard.setStringAsync(json); setNotice('Encrypted backup copied to clipboard. It stays encrypted — keep it safe.'); }
    catch { setNotice('Export failed.'); }
  }
  function handleExportPlaintext() {
    if (!plainArmed) { setPlainArmed(true); return; }
    try { const json = exportPlaintext(); setExported(json); void Clipboard.setStringAsync(json); setNotice('Plaintext export copied to clipboard. Anyone with it has every secret in readable form — delete it as soon as you are done.'); setPlainArmed(false); }
    catch { setNotice('Export failed.'); }
  }
  async function handleWipe() {
    if (!wipeArmed) { setWipeArmed(true); return; }
    await wipeVault(); onWiped();
  }
  const section = (title: string) => <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 24, marginBottom: 10 }}>{title}</Text>;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Text style={styles.title}>Settings</Text>
      {notice ? <Text testID="settings-notice" style={{ color: '#A5B4FC', fontSize: 14, lineHeight: 20, marginTop: 10 }}>{notice}</Text> : null}
      {section('Security')}
      <Field label="Current passphrase" testID="current-passphrase" placeholder="Current passphrase" secureTextEntry value={oldPass} onChangeText={setOldPass} autoCapitalize="none" autoCorrect={false} />
      <Field label="New passphrase" testID="new-passphrase" placeholder="At least 8 characters" secureTextEntry value={newPass} onChangeText={setNewPass} autoCapitalize="none" autoCorrect={false} />
      <Field label="Confirm new passphrase" testID="confirm-new-passphrase" placeholder="Repeat the new passphrase" secureTextEntry value={newConfirm} onChangeText={setNewConfirm} autoCapitalize="none" autoCorrect={false} />
      {changeError ? <Text testID="change-passphrase-error" style={[styles.error, { marginBottom: 10 }]}>{changeError}</Text> : null}
      {changeOk ? <Text testID="change-passphrase-ok" style={{ color: colors.ok, fontSize: 14, marginBottom: 10 }}>Passphrase changed. Your items were not re-encrypted — the same Master Key is now wrapped under the new passphrase. Your recovery key still works.</Text> : null}
      <Pressable testID="change-passphrase-button" accessibilityLabel="Change passphrase" accessibilityRole="button" style={styles.primaryButton} onPress={() => void handleChangePassphrase()}>
        <Text style={styles.primaryButtonText}>Change passphrase</Text>
      </Pressable>
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
      {section('Backup & export')}
      <Pressable testID="export-encrypted-button" accessibilityLabel="Export encrypted backup" style={styles.primaryButton} onPress={() => void handleExportEncrypted()}>
        <Text style={styles.primaryButtonText}>Export encrypted backup</Text>
      </Pressable>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 8 }}>The encrypted backup is copied to the clipboard as JSON. It can only be imported back into this vault. Import is in the desktop app; mobile import is not yet built — see README.</Text>
      <Pressable testID="export-plaintext-button" accessibilityLabel="Export plaintext" style={[styles.ghostButton, { marginTop: 12, borderColor: plainArmed ? colors.danger : colors.cardBorder }]} onPress={handleExportPlaintext}>
        <Text style={[styles.ghostButtonText, { color: plainArmed ? colors.danger : colors.text }]}>{plainArmed ? 'Tap again to confirm — plaintext export!' : 'Export plaintext (dangerous)'}</Text>
      </Pressable>
      <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, marginTop: 8 }}>Plaintext export contains every secret in readable form. Only use it when you explicitly need it, and delete it immediately afterwards.</Text>
      {exported ? (
        <View style={{ backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>Last export (first 200 characters):</Text>
          <Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'monospace', marginTop: 6 }}>{exported.slice(0, 200)}{exported.length > 200 ? '…' : ''}</Text>
        </View>
      ) : null}
      {section('Danger zone')}
      <Pressable testID="wipe-vault-button" accessibilityLabel="Delete entire vault" accessibilityRole="button" style={[styles.dangerButton, wipeArmed ? { opacity: 1 } : { opacity: 0.85 }]} onPress={() => { if (wipeArmed) { void handleWipe(); } else { Alert.alert('Delete entire vault?', 'This permanently deletes the vault, every item and the keys. There is no undo. Tap the button again to confirm.', [{ text: 'Cancel', style: 'cancel', onPress: () => setWipeArmed(false) }, { text: 'Arm delete', style: 'destructive', onPress: () => setWipeArmed(true) }]); } }}>
        <Text style={styles.primaryButtonText}>{wipeArmed ? 'Tap again to permanently delete the vault' : 'Delete entire vault…'}</Text>
      </Pressable>
      <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 16 }}>my-secrect 0.1.0 · Local-first E2EE · Argon2id + XChaCha20-Poly1305 (libsodium) · Not audited, not production-ready.</Text>
    </ScrollView>
  );
}
