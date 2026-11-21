import React, { useState } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { monoText, useMobileTheme } from '../theme';
import { generatePassword, generatePassphrase } from '../utils/password';
import StrengthMeter from '../components/StrengthMeter';
import { AppButton, AppPage, FormSection, Group, InlineError, Rule, SegmentedControl, SelectField, ToggleRow } from '../components/mobile-ui';
import { radius, space, textStyle } from '../ui/tokens';

type GeneratorKind = 'password' | 'passphrase';

export default function GeneratorScreen({ onApply, embedded = false }: { onApply?: (password: string) => void; embedded?: boolean } = {}) {
  const { colors } = useMobileTheme();
  const { t } = useTranslation();
  const [kind, setKind] = useState<GeneratorKind>('password');
  const [length, setLength] = useState(20);
  const [words, setWords] = useState(6);
  const [symbols, setSymbols] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [uppercase, setUppercase] = useState(true);
  const [pronounceable, setPronounceable] = useState(false);
  const [result, setResult] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  function changeKind(value: string) {
    setKind(value === 'passphrase' ? 'passphrase' : 'password');
    setResult(''); setCopied(false); setError('');
  }

  function generate() {
    setError(''); setCopied(false);
    try {
      setResult(kind === 'password'
        ? generatePassword({ length, symbols, numbers, uppercase, pronounceable })
        : generatePassphrase(words));
    } catch { setError(t('mobileUI.generatePasswordFailed')); }
  }

  async function copy() {
    setError('');
    try { await Clipboard.setStringAsync(result); setCopied(true); }
    catch { setError(t('mobileUI.clipboardFailed')); }
  }

  const password = kind === 'password';
  const label = t(password ? 'mobileUI.length' : 'mobileUI.words');
  const content = (
    <>
      <FormSection>
        <SegmentedControl
          testID="generator-kind"
          label={t('mobileUI.generatorType')}
          choices={[{ value: 'password', label: t('mobileUI.password') }, { value: 'passphrase', label: t('mobileUI.passphrase') }]}
          value={kind}
          onChange={changeKind}
        />
        <View style={{ backgroundColor: colors.sunken, gap: space[3], padding: space[4], borderRadius: radius.surface, minHeight: space[12] * 3, justifyContent: 'center' }}>
          <Text testID="generated-password" selectable={Boolean(result)} accessibilityLiveRegion="polite"
            style={[result ? monoText.key : textStyle.title, { color: colors.text }]}>
            {result || t('mobileUI.generateFirst')}
          </Text>
          {result && password ? <StrengthMeter password={result} /> : !result && (
            <Text style={[textStyle.caption, { color: colors.secondaryText }]}>{t('mobileUI.generateBody')}</Text>
          )}
        </View>
        {error ? <InlineError testID="generator-error">{error}</InlineError> : null}
        <AppButton testID="generate-button" icon="regenerate" label={t(result ? 'mobileUI.regenerate' : 'mobileUI.generate')} onPress={generate} />
        {onApply && (
          <AppButton testID="apply-generated-password" icon="check" label={t('mobileUI.applyPassword')} variant="secondary" disabled={!result} onPress={() => onApply(result)} />
        )}
        <AppButton testID="copy-generated-password" icon="copy" label={t(copied ? 'mobileUI.copied' : 'mobileUI.copy')} variant={onApply ? 'text' : 'secondary'} disabled={!result} onPress={() => void copy()} />
      </FormSection>
      <FormSection title={t('generator.options')}>
        <SelectField
          label={label}
          testID="generator-length"
          value={String(password ? length : words)}
          choices={(password ? [12, 16, 20, 24, 32, 48, 64] : [4, 5, 6, 7, 8, 10]).map(value => ({ value: String(value), label: t(password ? 'mobileUI.characters' : 'mobileUI.wordCount', value) }))}
          onChange={value => password ? setLength(Number(value)) : setWords(Number(value))}
        />
        {password && (
          <Group>
            <ToggleRow testID="gen-uppercase" label={t('mobileUI.uppercase')} value={uppercase} onChange={setUppercase} />
            <Rule />
            <ToggleRow testID="gen-numbers" label={t('mobileUI.numbers')} value={numbers} onChange={setNumbers} />
            <Rule />
            <ToggleRow testID="gen-symbols" label={t('mobileUI.symbols')} value={symbols} onChange={setSymbols} />
            <Rule />
            <ToggleRow testID="gen-pronounceable" label={t('mobileUI.pronounceable')} value={pronounceable} onChange={setPronounceable} />
          </Group>
        )}
      </FormSection>
    </>
  );
  return embedded ? <View style={{ gap: space[6] }}>{content}</View> : <AppPage testID="generator-screen">{content}</AppPage>;
}
