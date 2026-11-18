import React, { useState, type ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react-native';
import { useMobileTheme } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';

export function Page({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { colors } = useMobileTheme();
  const content = { padding: 20, paddingBottom: 36, width: '100%' as const, maxWidth: 720, alignSelf: 'center' as const };
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {scroll ? <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={content}>{children}</ScrollView> : <View style={[content, { flex: 1 }]}>{children}</View>}
  </KeyboardAvoidingView>;
}
export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const { colors } = useMobileTheme();
  return <View style={{ marginBottom: 26 }}>{title && <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 9, marginLeft: 14 }}>{title}</Text>}
    <View style={{ backgroundColor: colors.card, borderRadius: 14, overflow: 'hidden' }}>{children}</View>
    {footer && <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 9, marginHorizontal: 14 }}>{footer}</Text>}
  </View>;
}
export function Row({ label, detail, icon, onPress, destructive, children, testID }: { label: string; detail?: string; icon?: ReactNode; onPress?: () => void; destructive?: boolean; children?: ReactNode; testID?: string }) {
  const { colors } = useMobileTheme();
  return <Pressable testID={testID} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label} disabled={!onPress} onPress={onPress} style={({ pressed }) => ({ minHeight: 54, paddingHorizontal: 16, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: pressed ? colors.surface2 : colors.card })}>
    {icon}<View style={{ flex: 1, minWidth: 0 }}><Text style={{ color: destructive ? colors.dangerText : colors.text, fontSize: 16 }}>{label}</Text>{detail && <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 }}>{detail}</Text>}</View>
    {children ?? (onPress && <ChevronRight size={17} color={colors.muted} />)}
  </Pressable>;
}
export function Rule() { const { colors } = useMobileTheme(); return <View style={{ height: 0.5, marginLeft: 16, backgroundColor: colors.line }} />; }
export function ToggleRow({ label, value, onChange, testID }: { label: string; value: boolean; onChange: (value: boolean) => void; testID?: string }) {
  const { colors } = useMobileTheme();
  return <Row label={label}><Switch testID={testID} accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.accent }} /></Row>;
}
export function Action({ label, onPress, disabled, destructive, secondary, testID, icon }: { label: string; onPress: () => void; disabled?: boolean; destructive?: boolean; secondary?: boolean; testID?: string; icon?: ReactNode }) {
  const { colors } = useMobileTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 50, padding: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 8, flexDirection: 'row', backgroundColor: secondary ? colors.card : destructive ? colors.danger : colors.accent, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 })}>
    {icon}<Text style={{ color: secondary ? colors.text : '#FFFFFF', fontSize: 16, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}
export function SearchTrigger({ onPress }: { onPress: () => void }) {
  const { colors } = useMobileTheme(); const { t } = useTranslation();
  return <Pressable testID="global-search-trigger" accessibilityRole="button" accessibilityLabel={t('mobileUI.searchAll')} onPress={onPress} style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderRadius: 11, gap: 10, backgroundColor: colors.surface2 }}>
    <Search size={19} color={colors.muted} /><Text style={{ fontSize: 16, color: colors.muted }}>{t('mobileUI.searchAll')}</Text>
  </Pressable>;
}
export interface Choice { value: string; label: string; detail?: string; icon?: ReactNode }
export function Select({ value, choices, onChange, label, testID }: { value: string; choices: Choice[]; onChange: (value: string) => void; label: string; testID?: string }) {
  const { colors } = useMobileTheme(); const { dict } = useTranslation();const [open, setOpen] = useState(false); const [query, setQuery] = useState('');
  return <>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${label}: ${choices.find(c => c.value === value)?.label ?? value}`} accessibilityState={{ expanded: open }} onPress={() => { setQuery(''); setOpen(true); }} style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{choices.find(c => c.value === value)?.label ?? label}</Text><ChevronDown size={17} color={colors.muted} />
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable accessibilityLabel={dict.common.close} onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: '#00000055', justifyContent: 'flex-end' }}>
        <Pressable onPress={e => e.stopPropagation()} accessibilityViewIsModal style={{ maxHeight: '80%', width: '100%', maxWidth: 600, alignSelf: 'center', backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingBottom: 34 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 }}><Text style={{ color: colors.text, fontWeight: '600', fontSize: 20 }}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={dict.common.close} onPress={() => setOpen(false)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><X size={20} color={colors.muted} /></Pressable></View>
          {choices.length > 9 && <TextInput accessibilityLabel={dict.common.search} placeholder={dict.common.search} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={{ marginHorizontal: 20, marginVertical: 8, borderRadius: 10, padding: 13, backgroundColor: colors.surface2, color: colors.text, fontSize: 16 }} />}
          <ScrollView keyboardShouldPersistTaps="handled">{choices.filter(c => c.label.toLowerCase().includes(query.toLowerCase())).map(c => <Row key={c.value} testID={`${testID}-${c.value}`} label={c.label} detail={c.detail} icon={c.icon} onPress={() => { onChange(c.value); setOpen(false); }}>{value === c.value ? <Check size={20} color={colors.accent} /> : <View style={{ width: 20 }} />}</Row>)}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}
export function Empty({ image, title, detail, children }: { image?: number; title: string; detail?: string; children?: ReactNode }) {
  const { colors } = useMobileTheme();
  return <View style={{ alignItems: 'center', paddingHorizontal: 28, paddingVertical: 48 }}>
    {image && <Image source={image} style={{ width: 112, height: 112, marginBottom: 18 }} resizeMode="contain" />}
    <Text style={{ color: colors.text, fontSize: 22, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
    {detail && <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, maxWidth: 360 }}>{detail}</Text>}
    {children && <View style={{ marginTop: 24, alignSelf: 'stretch' }}>{children}</View>}
  </View>;
}
