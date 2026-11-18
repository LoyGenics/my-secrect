import React, { useState, type ReactNode } from 'react';
import { Image, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react-native';
import { useMobileTheme } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { InputControl } from './Field';

export function IconButton({ children, style, disabled, accessibilityState, ...props }: Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, styles } = useMobileTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, disabled: disabled ?? accessibilityState?.disabled }}
      disabled={disabled}
      {...props}
      style={({ pressed }) => [
        styles.iconButton,
        Platform.OS === 'android' && iconButtonStyles.android,
        style,
        pressed && { backgroundColor: colors.accentSoft },
        disabled && { opacity: 0.5 },
      ]}
    >
      {children}
    </Pressable>
  );
}

const iconButtonStyles = StyleSheet.create({ android: { width: 48, height: 48 } });

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
export function Row({ label, detail, icon, onPress, destructive, children, testID, selected, expanded }: { label: string; detail?: string; icon?: ReactNode; onPress?: () => void; destructive?: boolean; children?: ReactNode; testID?: string; selected?: boolean; expanded?: boolean }) {
  const { colors } = useMobileTheme();
  return <Pressable testID={testID} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label} accessibilityState={{ selected, expanded }} disabled={!onPress} onPress={onPress} style={({ pressed }) => ({ minHeight: 54, paddingHorizontal: 16, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: selected || pressed ? colors.accentSoft : colors.card })}>
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
    {icon}<Text style={{ color: secondary ? colors.text : colors.onAccent, fontSize: 16, fontWeight: '600', flexShrink: 1, textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}
export function SearchTrigger({ onPress }: { onPress: () => void }) {
  const { colors } = useMobileTheme(); const { t } = useTranslation();
  return <Pressable testID="global-search-trigger" accessibilityRole="button" accessibilityLabel={t('mobileUI.searchAll')} onPress={onPress} style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderRadius: 11, gap: 10, backgroundColor: colors.surface2 }}>
    <Search size={19} color={colors.muted} /><Text style={{ fontSize: 16, color: colors.muted }}>{t('mobileUI.searchAll')}</Text>
  </Pressable>;
}
export interface Choice { value: string; label: string; detail?: string; icon?: ReactNode }
export function Select({ value, choices, onChange, label, testID, style, createLabel, searchPlaceholder }: {
  value: string; choices: Choice[]; onChange: (value: string) => void; label: string; testID?: string; style?: StyleProp<ViewStyle>;
  createLabel?: (name: string) => string; searchPlaceholder?: string;
}) {
  const { colors, styles } = useMobileTheme();
  const { dict, t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = choices.find((choice) => choice.value === value);
  const name = query.trim();
  const matching = name ? choices.filter((choice) => choice.label.toLowerCase().includes(name.toLowerCase())) : choices;
  const create = createLabel && name && !matching.some((choice) => choice.label.toLowerCase() === name.toLowerCase()) ? createLabel(name) : '';
  const close = () => setOpen(false);

  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: selected?.label }}
        accessibilityState={{ expanded: open }}
        onPress={() => { Keyboard.dismiss(); setQuery(''); setOpen(true); }}
        style={({ pressed }) => [
          styles.inputShell,
          { minWidth: 0, gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
          style,
          (open || pressed) && styles.inputFocused,
        ]}
      >
        {selected?.icon}
        <Text style={{ flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={2}>{selected?.label ?? label}</Text>
        <ChevronDown size={18} color={open ? colors.focus : colors.secondary} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000055' }}>
          <Pressable accessible={false} onPress={close} style={StyleSheet.absoluteFill} />
          <View accessibilityViewIsModal style={{ maxHeight: '80%', width: '100%', maxWidth: 600, alignSelf: 'center', backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingBottom: Math.max(16, insets.bottom), overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 20, paddingRight: 12, paddingBottom: 8 }}>
              <Text accessibilityRole="header" style={{ flex: 1, color: colors.text, fontWeight: '600', fontSize: 20 }}>{label}</Text>
              <IconButton accessibilityLabel={dict.common.close} onPress={close}><X size={20} color={colors.secondary} /></IconButton>
            </View>
            {(choices.length > 9 || createLabel) && (
              <InputControl
                accessibilityLabel={dict.common.search}
                placeholder={searchPlaceholder ?? dict.common.search}
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
                leading={<Search size={18} color={colors.muted} />}
                containerStyle={{ marginHorizontal: 16, marginBottom: 12 }}
              />
            )}
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 12 }}>
              {!!create && <Row testID={testID && `${testID}-create`} label={create} onPress={() => { onChange(name); close(); }} />}
              {matching.length === 0 && !create && <Text style={[styles.small, { padding: 14 }]}>{t('mobileUI.noResults', name)}</Text>}
              {matching.map((choice) => (
                <View key={choice.value} style={{ borderRadius: 12, overflow: 'hidden' }}>
                  <Row
                    testID={testID && `${testID}-${choice.value}`}
                    label={choice.label}
                    detail={choice.detail}
                    icon={choice.icon}
                    selected={value === choice.value}
                    onPress={() => { onChange(choice.value); close(); }}
                  >
                    {value === choice.value ? <Check size={20} color={colors.link} /> : <View style={{ width: 20 }} />}
                  </Row>
                </View>
              ))}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
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
