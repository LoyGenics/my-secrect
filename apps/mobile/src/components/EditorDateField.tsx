import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { space } from '../ui/tokens';
import { daysInMonth, formatEditorDate, parseEditorDate } from '../utils/itemEditor';
import { InputControl } from './Field';
import { AppButton, BottomSheet, FieldGroup, InlineError, SegmentedControl, SettingsRow } from './mobile-ui';

const DATE_PARTS = ['year', 'month', 'day'] as const;

export default function EditorDateField({ label, value, onChange, testID, error, disabled }: {
  label: string; value: string; onChange: (next: string) => void; testID: string; error?: string; disabled?: boolean;
}) {
  const { dict, locale } = useTranslation();
  const { styles } = useMobileTheme();
  const copy = dict.mobileEditor;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'year' | 'month' | 'day'>('year');
  const [yearSearch, setYearSearch] = useState('');
  const [draft, setDraft] = useState({ year: 0, month: 0, day: 0 });
  const today = new Date();
  const stored = parseEditorDate(value);
  const example = { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() };
  const monthDate = (month: number) => new Date(Date.UTC(2024, month - 1, 1));
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const display = (date: typeof draft) => {
    const instant = monthDate(date.month);
    instant.setUTCFullYear(date.year, date.month - 1, date.day);
    return dateFormat.format(instant);
  };
  const showPicker = () => {
    setDraft(stored ?? example);
    setStep('year');
    setYearSearch('');
    setOpen(true);
  };
  const choose = (value: number) => {
    if (step === 'day') {
      setDraft({ ...draft, day: value });
      return;
    }
    const next = { ...draft, [step]: value };
    next.day = Math.min(next.day, daysInMonth(next.year, next.month));
    setDraft(next);
    setStep(step === 'year' ? 'month' : 'day');
  };
  const earliest = 1900;
  const latest = today.getFullYear() + 100;
  const years = Array.from({ length: latest - earliest + 1 }, (_, index) => earliest + index)
    .sort((a, b) => Math.abs(a - example.year) - Math.abs(b - example.year) || b - a);
  if (draft.year && (draft.year < earliest || draft.year > latest)) years.unshift(draft.year);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const days = Array.from({ length: daysInMonth(draft.year, draft.month) }, (_, index) => index + 1);
  const valueLabel = stored ? display(stored) : copy.chooseDate;
  return <View>
    <Text style={styles.label}>{label}</Text>
    <AppButton testID={testID} label={valueLabel} accessibilityLabel={format(copy.dateControl, label, valueLabel)}
      icon="expiring" variant="secondary" disabled={disabled} onPress={showPicker} />
    {error && <InlineError>{error}</InlineError>}
    {value && !stored && <Text style={styles.small}>{format(copy.legacyDate, value)}</Text>}
    {open && <BottomSheet title={label} visible={open} onClose={() => setOpen(false)} testID={`${testID}-sheet`}
      footer={<AppButton label={copy.applyDate} testID={`${testID}-apply`} disabled={!draft.year || !draft.month || !draft.day}
        onPress={() => { onChange(formatEditorDate(draft.year, draft.month, draft.day)); setOpen(false); }} />}>
      <FieldGroup style={local.choices}>
        <Text style={styles.small}>{display(draft)}</Text>
        <SegmentedControl label={copy.chooseDate} value={step} choices={DATE_PARTS.map((part) => ({ value: part, label: copy[part] }))}
          onChange={(value) => setStep(value as typeof step)} />
        {step === 'year' && <InputControl accessibilityLabel={copy.year} placeholder={copy.year} keyboardType="number-pad"
          maxLength={4} value={yearSearch} onChangeText={(next) => setYearSearch(next.replace(/\D/g, ''))} />}
        {value && <AppButton label={dict.common.clear} variant="text" testID={`${testID}-clear`} onPress={() => { onChange(''); setOpen(false); }} />}
      </FieldGroup>
      {(step === 'year' ? years.filter((year) => String(year).includes(yearSearch)) : step === 'month' ? months : days).map((candidate) => {
        const checked = draft[step] === candidate;
        return <SettingsRow key={candidate} label={step === 'month' ? monthFormat.format(monthDate(candidate)) : String(candidate)}
          testID={`${testID}-${step}-${candidate}`} accessibilityRole="radio" accessibilityState={{ checked }} selected={checked}
          onPress={() => choose(candidate)} />;
      })}
    </BottomSheet>}
  </View>;
}

const local = StyleSheet.create({
  choices: { marginBottom: space[3] },
});
