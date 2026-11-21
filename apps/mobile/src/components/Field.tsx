import React, { forwardRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { Icon, type NativeIconName } from '../../../../packages/ui/src/native';
import { format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { IconButton } from '../ui/buttons';
import { size, space } from '../ui/tokens';

interface InputControlProps extends TextInputProps {
  leading?: ReactNode;
  trailing?: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  invalid?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Cover fields (sign-in, search) are boxed with a >= 3:1 edge; body fields are an underline. */
  boxed?: boolean;
}

export const InputControl = forwardRef<TextInput, InputControlProps>(function InputControl(
  { leading, trailing, containerStyle, invalid, disabled, busy, boxed, multiline, onFocus, onBlur, style, keyboardAppearance, editable, accessibilityState, ...props }, ref,
) {
  const { colors, styles, scheme } = useMobileTheme();
  const [focused, setFocused] = useState(false);
  const off = !!disabled || !!busy || editable === false;
  const marked = focused || invalid;
  return (
    <View style={[styles.inputShell, boxed && styles.inputBoxed, containerStyle,
      marked && (boxed ? styles.inputBoxedFocused : styles.inputFocused), invalid && { borderColor: colors.dangerText, borderBottomColor: colors.dangerText, borderBottomWidth: 2 }, disabled && local.disabled]}>
      {leading && <View style={local.leading}>{leading}</View>}
      <TextInput
        ref={ref}
        multiline={multiline}
        placeholderTextColor={colors.mutedText}
        selectionColor={colors.focus}
        underlineColorAndroid="transparent"
        keyboardAppearance={keyboardAppearance ?? scheme}
        editable={!off}
        accessibilityState={{ ...accessibilityState, disabled: off, busy }}
        {...props}
        style={[styles.input, multiline && styles.inputMultiline, style]}
        onFocus={(event) => { setFocused(true); onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      />
      {trailing}
    </View>
  );
});

export interface AppTextFieldProps extends Omit<InputControlProps, 'invalid' | 'accessibilityLabel'> {
  label: string;
  testID?: string;
  error?: string;
  helper?: string;
  flush?: boolean;
  leadingIcon?: NativeIconName;
  revealable?: boolean;
}

export const AppTextField = forwardRef<TextInput, AppTextFieldProps>(function AppTextField(
  { label, testID, error, helper, flush, leading, leadingIcon, trailing, revealable, secureTextEntry, accessibilityHint, ...props }, ref,
) {
  const { colors, styles } = useMobileTheme();
  const { dict } = useTranslation();
  const [show, setShow] = useState(false);
  const message = error ?? helper;
  return (
    <View style={flush ? undefined : local.field}>
      <Text style={styles.label}>{label}</Text>
      <InputControl
        ref={ref}
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error ?? helper ?? accessibilityHint}
        invalid={!!error}
        secureTextEntry={revealable ? !show : secureTextEntry}
        leading={leadingIcon ? <Icon name={leadingIcon} color={colors.secondaryText} /> : leading}
        trailing={revealable ?
          <View style={local.actions}>
            <IconButton
              icon={show ? 'hide' : 'show'}
              testID={testID && `${testID}-visibility`}
              accessibilityLabel={format(show ? dict.itemDetail.hide : dict.itemDetail.show, label)}
              accessibilityState={{ selected: show }}
              disabled={props.disabled || props.busy}
              onPress={() => setShow(value => !value)}
            />
            {trailing}
          </View> : trailing}
        {...props}
      />
      {error ? <View style={local.messageRow}>
          <Icon name="error" size={size.inlineIcon} color={colors.dangerText} />
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" testID={testID && `${testID}-error`} style={[styles.error, local.flexText]}>{error}</Text>
        </View>
        : message ? <Text style={[styles.small, local.message]}>{message}</Text> : null}
    </View>
  );
});

export default AppTextField;

const local = StyleSheet.create({
  field: { marginBottom: space[5] },
  leading: { width: size.icon, alignItems: 'center', marginRight: space[3] },
  actions: { flexDirection: 'row', alignItems: 'center' },
  message: { marginTop: space[2] },
  messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], marginTop: space[2] },
  flexText: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.52 },
});
