import React, { useContext, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, View, findNodeHandle, useWindowDimensions,
  type AccessibilityRole, type AccessibilityState, type StyleProp, type ViewStyle,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon, type NativeIconName } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { AppButton, IconButton } from '../ui/buttons';
import { useReducedMotion } from '../ui/motion';
import { getPageGutter, radius, size, space, textStyle } from '../ui/tokens';
import { InputControl } from './Field';

export { AppButton, IconButton };
/** Use the platform dialog for native confirm and cancel semantics. */
export const Dialog = Alert;

interface AppPageProps {
  children: ReactNode;
  scroll?: boolean;
  width?: 'form' | 'list';
  header?: ReactNode;
  footer?: ReactNode;
  safeArea?: 'none' | 'bottom' | 'full';
  keyboardOffset?: number;
  contentStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function AppPage({ children, scroll = true, width = 'form', header, footer, safeArea = 'none', keyboardOffset, contentStyle, style, testID }: AppPageProps) {
  const { colors } = useMobileTheme();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  const frame = useRef<View>(null);
  const [windowY, setWindowY] = useState(0);
  const measureWindowY = () => {
    if (Platform.OS !== 'ios' || keyboardOffset !== undefined) return;
    const view = frame.current;
    view?.measureInWindow((_x, y) => {
      if (frame.current === view && Number.isFinite(y)) setWindowY(Math.max(0, y));
    });
  };
  const gutter = getPageGutter(windowWidth);
  const bottom = safeArea === 'none' ? 0 : insets?.bottom ?? 0;
  const column = {
    maxWidth: width === 'list' ? size.listWidth : size.formWidth,
    paddingLeft: gutter + (insets?.left ?? 0),
    paddingRight: gutter + (insets?.right ?? 0),
  };
  const body = [
    local.column, column, !!header && local.afterHeader, contentStyle,
    scroll && { paddingBottom: space[6] + (footer ? 0 : bottom) },
    !scroll && local.flex,
  ];
  return (
    <View ref={frame} collapsable={false} onLayout={measureWindowY} style={[local.flex, { backgroundColor: colors.canvas }, style]}>
      {/* iOS reports the keyboard in window coordinates and the React view in parent coordinates. */}
      <KeyboardAvoidingView testID={testID} behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset ?? windowY} style={[local.flex, { paddingTop: safeArea === 'full' ? insets?.top ?? 0 : 0 }]}>
        {header && <View style={[local.column, column, local.pageHeader]}>{header}</View>}
        {scroll
        ? <ScrollView style={local.flex} keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} contentContainerStyle={body}>{children}</ScrollView>
          : <View style={body}>{children}</View>}
        {footer && <View style={[local.column, column, local.pageFooter, {
          paddingBottom: space[3] + bottom, borderTopColor: colors.border, backgroundColor: colors.canvas,
        }]}>{footer}</View>}
        {!footer && !scroll && bottom > 0 && <View style={{ height: bottom }} />}
      </KeyboardAvoidingView>
    </View>
  );
}

/** @deprecated Use AppPage, which also supports list widths and sticky actions. */
export const Page = AppPage;

type SectionProps = { title?: string; description?: string; children: ReactNode; style?: StyleProp<ViewStyle> };

export function PageSection({ title, description, children, style }: SectionProps) {
  const { styles } = useMobileTheme();
  return <View style={[local.section, style]}>
    {title && <Text accessibilityRole="header" style={styles.heading}>{title}</Text>}
    {description && <Text style={styles.subtitle}>{description}</Text>}
    {children}
  </View>;
}

export function FormSection({ title, description, children, style }: SectionProps) {
  const { styles } = useMobileTheme();
  return <View style={[local.formSection, style]}>
    {title || description ? <View style={local.sectionHeading}>
      {title && <Text accessibilityRole="header" style={styles.heading}>{title}</Text>}
      {description && <Text style={styles.subtitle}>{description}</Text>}
    </View> : null}
    {children}
  </View>;
}

/** Use flush fields inside a FieldGroup. */
export function FieldGroup({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[local.fieldGroup, style]}>{children}</View>;
}

export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const { colors, styles } = useMobileTheme();
  return <View style={local.group}>
    {title && <Text accessibilityRole="header" style={[styles.label, local.groupLabel]}>{title}</Text>}
    <View style={[local.groupSurface, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
    {footer && <Text style={[styles.small, local.groupFooter]}>{footer}</Text>}
  </View>;
}

interface SettingsRowProps {
  label: string;
  detail?: string;
  value?: string;
  icon?: ReactNode | NativeIconName;
  onPress?: () => void;
  destructive?: boolean;
  children?: ReactNode;
  testID?: string;
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  navigation?: boolean;
  leadingSpace?: boolean;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
}

export function SettingsRow({
  label, detail, value, icon, onPress, destructive, children, testID, selected, disabled, expanded, navigation, leadingSpace, accessibilityRole = 'button', accessibilityState,
}: SettingsRowProps) {
  const { colors } = useMobileTheme();
  const glyph = typeof icon === 'string' ? <Icon name={icon as NativeIconName} color={colors.primaryTextLink} /> : icon;
  const isCheckbox = accessibilityRole === 'checkbox';
  const checked = accessibilityState?.checked ?? selected ?? false;
  const content = <>
    {(glyph || leadingSpace) && <View style={local.leadingSlot}>{glyph}</View>}
    <View style={local.rowText}>
      <Text style={[textStyle.body, { color: destructive ? colors.dangerText : colors.text }]}>{label}</Text>
      {detail && <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{detail}</Text>}
    </View>
    {value && <Text style={[textStyle.helper, local.rowValue, { color: colors.secondaryText }]}>{value}</Text>}
    {children ?? (isCheckbox ? <View style={[local.checkbox, {
      borderColor: checked ? colors.primaryFill : colors.controlBorder,
      backgroundColor: checked ? colors.primaryFill : colors.surface,
    }]}>
      {checked && <Icon name="check" size={size.inlineIcon} color={colors.onPrimary} />}
    </View> : selected !== undefined ? <View style={local.trailingSlot}>{selected && <Icon name="check" color={colors.primaryTextLink} />}</View>
      : navigation && <Icon name="forward" size={size.inlineIcon} color={colors.secondaryText} />)}
  </>;
  if (!onPress) return <View testID={testID} style={local.row}>{content}</View>;
  return (
    <Pressable testID={testID} accessibilityRole={accessibilityRole} accessibilityLabel={label}
      accessibilityHint={detail} accessibilityValue={value ? { text: value } : undefined}
      accessibilityState={{ selected: accessibilityRole === 'button' ? selected : undefined, checked: isCheckbox ? checked : undefined,
        expanded, ...accessibilityState, disabled }}
      disabled={disabled} onPress={onPress} style={({ pressed }) => [local.row, (pressed || selected) && { backgroundColor: colors.selection }, disabled && local.disabled]}>
      {content}
    </Pressable>
  );
}

/** @deprecated Use SettingsRow and opt in to the navigation chevron. */
export function Row(props: SettingsRowProps) {
  const navigation = props.navigation ?? (!!props.onPress && !props.children && props.selected === undefined && props.expanded === undefined && !props.destructive);
  return <SettingsRow {...props} navigation={navigation} />;
}

export function Rule({ leading = false }: { leading?: boolean }) {
  const { colors } = useMobileTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, marginLeft: space[4] + (leading ? size.leadingSlot + space[3] : 0), backgroundColor: colors.border }} />;
}

export function ToggleRow({ label, detail, icon, value, onChange, testID, disabled }: {
  label: string; detail?: string; icon?: SettingsRowProps['icon']; value: boolean; onChange: (value: boolean) => void; testID?: string; disabled?: boolean;
}) {
  const { colors } = useMobileTheme();
  return <SettingsRow label={label} detail={detail} icon={icon}>
    <Switch testID={testID} accessibilityLabel={label} accessibilityHint={detail} value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: colors.primaryFill }} />
  </SettingsRow>;
}

/** @deprecated Use AppButton with an explicit variant. */
export function Action({ secondary, destructive, ...props }: Omit<Parameters<typeof AppButton>[0], 'variant'> & { secondary?: boolean; destructive?: boolean }) {
  return <AppButton {...props} variant={destructive ? 'destructive' : secondary ? 'secondary' : 'primary'} />;
}

export function SearchTrigger({ onPress, testID = 'global-search-trigger' }: { onPress: () => void; testID?: string }) {
  const { colors, styles } = useMobileTheme();
  const { t } = useTranslation();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={t('mobileUI.searchAll')} onPress={onPress}
    style={({ pressed }) => [styles.inputShell, local.selectTrigger, pressed && styles.inputFocused]}>
    <Icon name="search" color={colors.secondaryText} />
    <Text style={[textStyle.body, local.flexText, { color: colors.secondaryText }]}>{t('mobileUI.searchAll')}</Text>
  </Pressable>;
}

export interface Choice { value: string; label: string; detail?: string; icon?: ReactNode | NativeIconName }
interface SelectProps {
  value: string; choices: Choice[]; onChange: (value: string) => void; label: string; testID?: string; style?: StyleProp<ViewStyle>;
  createLabel?: (name: string) => string; placeholder?: string; disabled?: boolean; compact?: boolean;
}

export function Select({ value, choices, onChange, label, testID, style, createLabel, placeholder, disabled, compact }: SelectProps) {
  const { colors, styles } = useMobileTheme();
  const { dict, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = choices.find((choice) => choice.value === value);
  const glyph = typeof selected?.icon === 'string' ? <Icon name={selected.icon as NativeIconName} color={colors.primaryTextLink} /> : selected?.icon;
  const name = query.trim();
  const matching = name ? choices.filter((choice) => choice.label.toLowerCase().includes(name.toLowerCase())) : choices;
  const create = createLabel && name && !choices.some((choice) => choice.label.toLowerCase() === name.toLowerCase()) ? createLabel(name) : '';
  const close = () => setOpen(false);
  const choose = (next: string) => { onChange(next); close(); };
  return (
    <>
      <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label}
        accessibilityValue={selected ? { text: selected.label } : undefined} accessibilityState={{ expanded: open, disabled }}
        disabled={disabled} onPress={() => { Keyboard.dismiss(); setQuery(''); setOpen(true); }}
        style={({ pressed }) => [styles.inputShell, local.selectTrigger, style, (open || pressed) && styles.inputFocused, disabled && local.disabled]}>
        {glyph}
        <Text style={[textStyle.body, local.flexText, { color: selected ? colors.text : colors.secondaryText }]}>{selected?.label ?? placeholder ?? label}</Text>
        <Icon name="expand" size={size.inlineIcon} color={colors.secondaryText} />
      </Pressable>
      <BottomSheet visible={open} title={label} onClose={close} testID={testID && `${testID}-sheet`} compact={compact}>
        {(choices.length > 9 || createLabel) &&
          <InputControl accessibilityLabel={dict.common.search} placeholder={placeholder ?? dict.common.search} value={query}
            onChangeText={setQuery} autoCorrect={false} leading={<Icon name="search" size={size.inlineIcon} color={colors.secondaryText} />}
            containerStyle={local.sheetSearch} />}
        {!!create && <SettingsRow testID={testID && `${testID}-create`} label={create} icon="add" onPress={() => choose(name)} />}
        {matching.length === 0 && !create && <Text style={styles.small}>{t('mobileUI.noResults', name)}</Text>}
        {matching.map((choice, index) => (
          <React.Fragment key={choice.value}>
            {index > 0 && <Rule leading={!!choice.icon} />}
            <SettingsRow label={choice.label} detail={choice.detail} icon={choice.icon}
              testID={testID && `${testID}-${choice.value}`} selected={value === choice.value}
              accessibilityRole="radio" accessibilityState={{ checked: value === choice.value }} onPress={() => choose(choice.value)} />
          </React.Fragment>
        ))}
      </BottomSheet>
    </>
  );
}

export function SelectField({ label, error, helper, flush, ...props }: SelectProps & { error?: string; helper?: string; flush?: boolean }) {
  const { styles } = useMobileTheme();
  return <View style={flush ? undefined : local.selectField}>
    <Text style={styles.label}>{label}</Text>
    <Select {...props} label={label} />
    {error ? <InlineError>{error}</InlineError> : helper ? <Text style={[styles.small, local.helper]}>{helper}</Text> : null}
  </View>;
}

export function SegmentedControl({ label, choices, value, onChange, testID, disabled }: {
  label: string; choices: Choice[]; value: string; onChange: (value: string) => void; testID?: string; disabled?: boolean;
}) {
  const { colors, styles } = useMobileTheme();
  const { fontScale } = useWindowDimensions();
  const stack = fontScale >= 1.3 || choices.length > 3;
  return <View>
    <Text style={styles.label}>{label}</Text>
    <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel={label} style={[
      local.segmentGroup, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }, stack && local.segmentStack,
    ]}>
      {choices.map((choice) => {
        const checked = value === choice.value;
        return <Pressable key={choice.value} testID={testID && `${testID}-${choice.value}`} accessibilityRole="radio"
          accessibilityLabel={choice.label} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onChange(choice.value)}
          style={({ pressed }) => [local.segment, !stack && local.flex, { borderColor: checked ? colors.primaryTextLink : 'transparent' },
            (pressed || checked) && { backgroundColor: colors.selection }, disabled && local.disabled]}>
          <Text style={[textStyle.item, local.center, { color: colors.text }]}>{choice.label}</Text>
        </Pressable>;
      })}
    </View>
  </View>;
}

export function FilterChip({ label, selected, onPress, onRemove, icon, testID, count, disabled }: {
  label: string; selected?: boolean; onPress?: () => void; onRemove?: () => void; icon?: NativeIconName; testID?: string; count?: number; disabled?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  return <Pressable testID={testID} accessibilityLabel={label} accessibilityRole="button"
    accessibilityHint={onRemove ? dict.common.remove : undefined} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onRemove ?? onPress}
    style={({ pressed }) => [local.filterChip, { borderColor: colors.controlBorder, backgroundColor: selected || pressed ? colors.selection : colors.surface }, disabled && local.disabled]}>
    {icon && <Icon name={icon} size={size.inlineIcon} color={colors.primaryTextLink} />}
    <Text style={[textStyle.helper, local.chipLabel, { color: colors.text }]}>{label}</Text>
    {!!count && <Text style={[textStyle.caption, local.badge, { backgroundColor: colors.primaryFill, color: colors.onPrimary }]}>{count}</Text>}
    {onRemove && <Icon name="close" size={size.inlineIcon} color={colors.secondaryText} />}
  </Pressable>;
}

export function BottomSheet({ visible, title, onClose, children, footer, testID, scroll = true, compact }: {
  visible: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; testID?: string; scroll?: boolean; compact?: boolean;
}) {
  const { colors } = useMobileTheme();
  const insets = useContext(SafeAreaInsetsContext);
  const { width } = useWindowDimensions();
  const gutter = getPageGutter(width);
  const reduced = useReducedMotion();
  const heading = useRef<Text>(null);
  const { dict } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType={reduced ? 'none' : 'fade'} onRequestClose={onClose}
      onShow={() => {
        const tag = findNodeHandle(heading.current);
        if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
      }}>
      <KeyboardAvoidingView style={[local.sheetOverlay, { backgroundColor: colors.scrim }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessible={false} importantForAccessibility="no" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View testID={testID} accessibilityViewIsModal style={[local.sheet, compact && local.compactSheet, {
          backgroundColor: colors.surface, paddingBottom: (insets?.bottom ?? 0) + space[3],
        }]}>
          <View style={[local.sheetHeader, { paddingHorizontal: gutter }]}>
            <Text ref={heading} accessibilityRole="header" style={[textStyle.title, local.flexText, { color: colors.text }]}>{title}</Text>
            <IconButton accessibilityLabel={dict.common.close} icon="close" onPress={onClose} testID={testID && `${testID}-close`} />
          </View>
          {scroll ? <ScrollView style={local.sheetBody} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: space[2] }}>
            {children}
          </ScrollView> : <View style={[local.sheetBody, { paddingHorizontal: gutter }]}>{children}</View>}
          {footer && <View style={[local.sheetFooter, { paddingHorizontal: gutter, borderTopColor: colors.border }]}>{footer}</View>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function EmptyState({ image, title, detail, children }: { image?: number; title: string; detail?: string; children?: ReactNode }) {
  const { colors } = useMobileTheme();
  return <View style={local.empty}>
    {image && <Image source={image} style={local.emptyArt} resizeMode="contain" accessible={false} />}
    <Text accessibilityRole="header" style={[textStyle.title, local.center, { color: colors.text }]}>{title}</Text>
    {detail && <Text style={[textStyle.helper, local.center, { color: colors.secondaryText }]}>{detail}</Text>}
    {children && <View style={local.emptyActions}>{children}</View>}
  </View>;
}

/** @deprecated Use EmptyState. */
export const Empty = EmptyState;

export function InlineError({ children, testID }: { children: ReactNode; testID?: string }) {
  const { styles } = useMobileTheme();
  return <Text testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.error, local.helper]}>{children}</Text>;
}

export function Progress({ value, label, testID }: { value?: number; label: string; testID?: string }) {
  const { colors } = useMobileTheme();
  const percentage = value !== undefined ? Math.round(Math.max(0, Math.min(1, value)) * 100) : undefined;
  return <View testID={testID} accessibilityRole="progressbar" accessibilityLabel={label}
    accessibilityValue={percentage === undefined ? undefined : { min: 0, max: 100, now: percentage }} style={local.progress}>
    <Text style={[textStyle.helper, local.center, { color: colors.secondaryText }]}>{label}</Text>
    {percentage === undefined ? <ActivityIndicator color={colors.primaryTextLink} />
      : <View style={[local.progressTrack, { backgroundColor: colors.surfaceMuted }]}>
        <View style={[local.progressTrack, { backgroundColor: colors.primaryFill, width: `${percentage}%` }]} />
      </View>}
  </View>;
}

export function Toast({ message, dismissLabel, onDismiss, testID }: { message: string; dismissLabel: string; onDismiss: () => void; testID?: string }) {
  const { colors } = useMobileTheme();
  return <View testID={testID} style={[local.toast, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[textStyle.helper, local.flexText, { color: colors.text }]}>{message}</Text>
    <IconButton icon="close" accessibilityLabel={dismissLabel} onPress={onDismiss} />
  </View>;
}

const local = StyleSheet.create({
  flex: { flex: 1 },
  flexText: { flex: 1, minWidth: 0 },
  center: { textAlign: 'center' },
  disabled: { opacity: 0.48 },
  column: { width: '100%', alignSelf: 'center', paddingTop: space[5] },
  afterHeader: { paddingTop: 0 },
  pageHeader: { paddingBottom: space[3] },
  pageFooter: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space[3] },
  section: { gap: space[3], marginBottom: space[8] },
  formSection: { marginBottom: space[6] },
  sectionHeading: { gap: space[1], marginBottom: space[4] },
  fieldGroup: { gap: space[4] },
  group: { marginBottom: space[6] },
  groupLabel: { marginBottom: space[2] },
  groupSurface: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.surface, overflow: 'hidden' },
  groupFooter: { marginTop: space[2] },
  row: { minHeight: size.settingsRow, paddingHorizontal: space[4], paddingVertical: space[3], flexDirection: 'row', alignItems: 'center', gap: space[3] },
  rowText: { flex: 1, minWidth: 0, gap: space[1] },
  rowValue: { maxWidth: '38%', textAlign: 'right' },
  leadingSlot: { width: size.leadingSlot, alignItems: 'center', flexShrink: 0 },
  trailingSlot: { width: size.icon, alignItems: 'center', flexShrink: 0 },
  checkbox: { width: size.icon, height: size.icon, borderRadius: radius.checkbox, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  selectTrigger: { minWidth: 0, gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] },
  selectField: { marginBottom: space[4] },
  helper: { marginTop: space[1] },
  segmentGroup: { flexDirection: 'row', padding: space[1], gap: space[1], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.field },
  segmentStack: { flexDirection: 'column' },
  segment: { borderWidth: 1, borderRadius: radius.glyph, minHeight: Platform.OS === 'android' ? size.androidTouch : size.touch, justifyContent: 'center', paddingHorizontal: space[2] },
  filterChip: { minHeight: Platform.OS === 'android' ? size.androidTouch : size.touch, minWidth: size.touch, paddingHorizontal: space[3], paddingVertical: space[1], gap: space[2], flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: radius.full, borderWidth: 1 },
  chipLabel: { fontWeight: '600', flexShrink: 1 },
  badge: { textAlign: 'center', minWidth: size.icon, borderRadius: radius.full, paddingHorizontal: space[1] },
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '82%', width: '100%', maxWidth: size.visibleSheetWidth, alignSelf: 'center', borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, overflow: 'hidden' },
  compactSheet: { maxHeight: '56%' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: space[3], paddingBottom: space[2], gap: space[2] },
  sheetSearch: { marginBottom: space[3] },
  sheetBody: { flexGrow: 0, flexShrink: 1 },
  sheetFooter: { paddingTop: space[3], borderTopWidth: StyleSheet.hairlineWidth, gap: space[3] },
  empty: { alignItems: 'center', paddingVertical: space[10], gap: space[2] },
  emptyArt: { width: size.emptyArt, height: size.emptyArt, marginBottom: space[2] },
  emptyActions: { marginTop: space[3], alignSelf: 'stretch', gap: space[3] },
  progress: { gap: space[2], paddingVertical: space[2] },
  progressTrack: { height: space[2], borderRadius: radius.full, overflow: 'hidden' },
  toast: { flexDirection: 'row', alignItems: 'center', paddingLeft: space[3], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.surface },
});
