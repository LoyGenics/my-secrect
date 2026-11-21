import React, { useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type NativeIconName } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { getButtonState, radius, size as controlSize, space, textStyle, type AppButtonSize } from './tokens';

export function IconButton({ accessibilityLabel, accessibilityState, children, disabled, icon, style, tone = 'default', onFocus, onBlur, ...props }:
  Omit<PressableProps, 'style' | 'children' | 'accessibilityLabel'> & {
    accessibilityLabel: string;
    children?: ReactNode;
    icon?: NativeIconName;
    style?: StyleProp<ViewStyle>;
    tone?: 'default' | 'link' | 'danger';
  }) {
  const { colors, styles } = useMobileTheme();
  const [focused, setFocused] = useState(false);
  const color = tone === 'link' ? colors.primaryTextLink : tone === 'danger' ? colors.dangerText : colors.text;
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, disabled: disabled ?? accessibilityState?.disabled }}
      disabled={disabled}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={({ pressed }) => [
        styles.iconButton,
        Platform.OS === 'android' && local.androidIcon,
        style,
        (pressed || focused) && { backgroundColor: colors.selection },
        disabled && local.disabled,
      ]}
    >
      {icon ? <Icon name={icon} color={color} /> : children}
      {focused && <View pointerEvents="none" style={[local.focus, { borderColor: colors.focus }]} />}
    </Pressable>
  );
}

export interface AppButtonProps {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive' | 'text';
  size?: AppButtonSize;
  loading?: boolean;
  disabled?: boolean;
  icon?: NativeIconName | ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function AppButton({ label, accessibilityLabel = label, onPress, variant = 'primary', size = 'default', loading, disabled, icon, testID, style }: AppButtonProps) {
  const { colors, styles } = useMobileTheme();
  const [focused, setFocused] = useState(false);
  const isText = variant === 'text';
  const { busy, inactive, iconOnly, compact, minHeight, width } = getButtonState(size, isText, Platform.OS === 'android', !!disabled, !!loading);
  // Orange is the one primary action; secondary is a sunken pill; tertiary and text are plum text.
  const appearance = {
    primary: [styles.primaryButton, colors.onPrimary],
    secondary: [styles.ghostButton, colors.text],
    tertiary: [styles.ghostButton, colors.primaryTextLink],
    destructive: [styles.dangerButton, colors.onDanger],
    text: [styles.ghostButton, colors.primaryTextLink],
  } as const;
  const [button, enabledInk] = appearance[variant];
  // A disabled action turns neutral (sunken + tertiary ink), never a pale orange.
  const neutral = disabled && !busy && !isText && variant !== 'tertiary';
  const ink = neutral ? colors.mutedText : enabledInk;
  const glyph = typeof icon === 'string' ? <Icon name={icon as NativeIconName} color={ink} /> : icon;
  const spinner = <ActivityIndicator size="small" color={ink} />;
  const pressedFill = variant === 'primary' ? colors.primaryPressed : variant === 'destructive' ? colors.dangerPressed : colors.selection;
  const focusInk = colors.focus;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        button,
        (isText || variant === 'tertiary') && local.textButton,
        compact && { minHeight, paddingVertical: space[1], borderRadius: minHeight / 2 },
        iconOnly && { width, paddingHorizontal: 0 },
        !glyph && !iconOnly && local.labelOnlyButton,
        style,
        neutral && { backgroundColor: colors.sunken },
        disabled && !busy && !neutral && local.disabled,
        pressed && { backgroundColor: pressedFill },
      ]}
    >
      {(glyph || iconOnly) && <View style={local.glyph}>{busy ? spinner : glyph}</View>}
      {!iconOnly &&
        <View style={local.label}>
          {busy && !glyph && <View style={[local.glyph, local.overlaySpinner]}>{spinner}</View>}
          <Text style={[textStyle.strong, local.labelText, { color: ink }]}>{label}</Text>
        </View>}
      {focused && <View pointerEvents="none" style={[local.focus, { borderColor: focusInk, borderRadius: compact ? minHeight / 2 : radius.button }]} />}
    </Pressable>
  );
}

const local = StyleSheet.create({
  androidIcon: { width: controlSize.androidTouch, height: controlSize.androidTouch },
  disabled: { opacity: 0.48 },
  focus: { ...StyleSheet.absoluteFillObject, borderWidth: 2, borderRadius: radius.chip },
  textButton: { backgroundColor: 'transparent', borderWidth: 0 },
  labelOnlyButton: { paddingHorizontal: space[6] },
  glyph: { width: controlSize.icon, height: controlSize.icon, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  label: { flexShrink: 1, justifyContent: 'center' },
  labelText: { textAlign: 'center', flexShrink: 1 },
  overlaySpinner: { position: 'absolute', left: -(controlSize.icon + space[2]), zIndex: 1 },
});
