import React, { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Copy, RefreshCw } from 'lucide-react-native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { generatePassword, generatePassphrase } from '../utils/password';
import StrengthMeter from '../components/StrengthMeter';
import { Action, Group, Page, Select, ToggleRow } from '../components/mobile-ui';

export default function GeneratorScreen() {
  const { colors } = useMobileTheme(); const { t } = useTranslation();
  const [kind, setKind] = useState('password');
  const [length, setLength] = useState(20); const [words, setWords] = useState(6);
  const [symbols, setSymbols] = useState(true); const [numbers, setNumbers] = useState(true);
  const [uppercase, setUppercase] = useState(true); const [pronounceable, setPronounceable] = useState(false);
  const [result, setResult] = useState(''); const [copied, setCopied] = useState(false); const [error, setError] = useState('');
  function generate() {
    setError(''); setCopied(false);
    try { setResult(kind === 'password' ? generatePassword({ length, symbols, numbers, uppercase, pronounceable }) : generatePassphrase(words)); }
    catch (e) { setError(e instanceof Error ? e.message : t('mobileUI.saveFailed')); }
  }
  return <Page>
    <View style={{ flexDirection: 'row', borderRadius: 10, backgroundColor: colors.surface2, padding: 3, marginBottom: 24 }}>
      {['password', 'passphrase'].map(value => <Pressable key={value} testID={`generator-kind-${value}`} accessibilityRole="tab" accessibilityState={{ selected: kind === value }} onPress={() => { setKind(value); setResult(''); setCopied(false); }} style={{ flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: kind === value ? colors.card : 'transparent' }}><Text style={{ fontSize: 15, fontWeight: '600', color: kind === value ? colors.text : colors.muted }}>{t(`mobileUI.${value}`)}</Text></Pressable>)}
    </View>
    <View style={{ backgroundColor: colors.card, padding: 22, borderRadius: 14, marginBottom: 18, minHeight: 168, justifyContent: 'center' }}>
      <Text testID="generated-password" selectable accessibilityLiveRegion="polite" style={{ fontSize: result ? 27 : 22, lineHeight: 36, fontWeight: '600', color: colors.text, fontFamily: result ? Platform.select({ ios: 'Menlo', default: 'monospace' }) : undefined }}>{result || t('mobileUI.generateFirst')}</Text>
      {result && kind === 'password' ? <View style={{ marginTop: 14 }}><StrengthMeter password={result} /></View> : <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 10 }}>{t('mobileUI.generateBody')}</Text>}
    </View>
    <View style={{ flexDirection: 'row', gap: 12, marginBottom: 28 }}>
      <View style={{ flex: 1 }}><Action testID="generate-button" label={result ? t('mobileUI.regenerate') : t('mobileUI.generate')} icon={<RefreshCw size={18} color="#FFFFFF" />} onPress={generate} /></View>
      <View style={{ flex: 1 }}><Action testID="copy-generated-password" label={copied ? t('mobileUI.copied') : t('mobileUI.copy')} secondary icon={<Copy size={18} color={colors.text} />} disabled={!result} onPress={() => void Clipboard.setStringAsync(result).then(() => setCopied(true))} /></View>
    </View>
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.dangerText, marginBottom: 18 }}>{error}</Text>}
    <Group title={t('generator.options')}>
      <View style={{ paddingHorizontal: 16 }}><Select label={kind === 'password' ? t('mobileUI.length') : t('mobileUI.words')} testID="generator-length" value={String(kind === 'password' ? length : words)} choices={(kind === 'password' ? [12,16,20,24,32,48,64] : [4,5,6,7,8,10]).map(n => ({ value: String(n), label: t(kind === 'password' ? 'mobileUI.characters' : 'mobileUI.wordCount', n) }))} onChange={v => kind === 'password' ? setLength(Number(v)) : setWords(Number(v))} /></View>
      {kind === 'password' && <><ToggleRow testID="gen-uppercase" label={t('mobileUI.uppercase')} value={uppercase} onChange={setUppercase} /><ToggleRow testID="gen-numbers" label={t('mobileUI.numbers')} value={numbers} onChange={setNumbers} /><ToggleRow testID="gen-symbols" label={t('mobileUI.symbols')} value={symbols} onChange={setSymbols} /><ToggleRow testID="gen-pronounceable" label={t('mobileUI.pronounceable')} value={pronounceable} onChange={setPronounceable} /></>}
    </Group>
  </Page>;
}
