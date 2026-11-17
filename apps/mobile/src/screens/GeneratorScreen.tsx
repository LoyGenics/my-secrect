import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors, styles } from '../theme';
import { generatePassword, generatePassphrase, passwordStrength } from '../utils/password';
import StrengthMeter from '../components/StrengthMeter';

export default function GeneratorScreen() {
  const [length, setLength] = useState(16);
  const [symbols, setSymbols] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [uppercase, setUppercase] = useState(true);
  const [pronounceable, setPronounceable] = useState(false);
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [genError, setGenError] = useState('');
  function generate() {
    setGenError('');
    try { setPassword(generatePassword({ length, symbols, numbers, uppercase, pronounceable })); setCopied(false); }
    catch (e) { setGenError(e instanceof Error ? e.message : 'Could not generate a password.'); }
  }
  function generatePassphraseValue() {
    setGenError('');
    try { setPassphrase(generatePassphrase(6)); }
    catch (e) { setGenError(e instanceof Error ? e.message : 'Could not generate a passphrase.'); }
  }
  const toggle = (label: string, value: boolean, onPress: () => void) => (
    <Pressable testID={`gen-toggle-${label}`} accessibilityLabel={label} accessibilityRole="checkbox" accessibilityState={{ checked: value }} onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 8 }}>
      <Text style={{ fontSize: 20, color: value ? colors.accent : colors.faint }}>{value ? '☑' : '☐'}</Text>
      <Text style={{ color: colors.text, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.title}>Generator</Text>
      <Text style={styles.subtitle}>Create strong passwords and passphrases. Generated values are shown on this screen only — copy one into the item you are creating.</Text>
      <Text style={[styles.label, { marginTop: 16 }]}>Length: {length}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[12, 16, 20, 24, 32].map((n) => (
          <Pressable key={n} testID={`gen-length-${n}`} accessibilityLabel={`Length ${n}`} onPress={() => setLength(n)} style={{ backgroundColor: length === n ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, marginRight: 8, marginBottom: 8 }}>
            <Text style={{ color: length === n ? '#FFF' : colors.text, fontWeight: '600' }}>{n}</Text>
          </Pressable>
        ))}
      </View>
      {toggle('Symbols (!@#$…)', symbols, () => setSymbols((v) => !v))}
      {toggle('Numbers (0-9)', numbers, () => setNumbers((v) => !v))}
      {toggle('Uppercase (A-Z)', uppercase, () => setUppercase((v) => !v))}
      {toggle('Pronounceable (word-word-123)', pronounceable, () => setPronounceable((v) => !v))}
      <Pressable testID="generate-button" accessibilityLabel="Generate password" accessibilityRole="button" style={[styles.primaryButton, { marginTop: 8 }]} onPress={generate}>
        <Text style={styles.primaryButtonText}>Generate password</Text>
      </Pressable>
      {password ? (
        <View style={{ marginTop: 16 }}>
          <View style={{ backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 14 }}>
            <Text testID="generated-password" accessibilityLabel={`Generated password ${password}`} selectable style={{ color: colors.text, fontSize: 17, fontFamily: 'monospace' }}>{password}</Text>
          </View>
          <StrengthMeter password={password} />
          <Text style={{ color: colors.muted, fontSize: 13 }}>Strength: {passwordStrength(password).label}</Text>
          <Pressable testID="copy-generated" accessibilityLabel="Copy generated password" style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => { void Clipboard.setStringAsync(password); setCopied(true); }}>
            <Text style={styles.ghostButtonText}>{copied ? 'Copied to clipboard' : 'Copy password'}</Text>
          </Pressable>
        </View>
      ) : null}
      {genError ? <Text testID="generator-error" style={[styles.error, { marginTop: 12 }]}>{genError}</Text> : null}
      <View style={{ marginTop: 24 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Passphrase</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 }}>Six random words from a 128-word list, picked with the system CSPRNG. Use 6+ words for the master passphrase itself.</Text>
        <Pressable testID="generate-passphrase-button" accessibilityLabel="Generate passphrase" style={[styles.ghostButton, { marginTop: 10 }]} onPress={generatePassphraseValue}>
          <Text style={styles.ghostButtonText}>Generate passphrase</Text>
        </Pressable>
        {passphrase ? <Text testID="generated-passphrase" selectable style={{ color: colors.text, fontSize: 16, fontFamily: 'monospace', marginTop: 12 }}>{passphrase}</Text> : null}
      </View>
    </ScrollView>
  );
}
