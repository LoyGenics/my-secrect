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
}

export const InputControl = forwardRef<TextInput, InputControlProps>(function InputControl(
  { leading, trailing, containerStyle, invalid, disabled, busy, multiline, onFocus, onBlur, style, keyboardAppearance, editable, accessibilityState, ...props }, ref,
) {
  const { colors, styles, scheme } = useMobileTheme();
  const [focused, setFocused] = useState(false);
  const off = !!disabled || !!busy || editable === false;
  return (
    <View style={[styles.inputShell, containerStyle, focused && styles.inputFocused, invalid && { borderColor: colors.dangerText }, disabled && local.disabled]}>
      {leading && <View style={local.leading}>{leading}</View>}
      <TextInput
        ref={ref}
        multiline={multiline}
        placeholderTextColor={colors.muted}
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
      {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" testID={testID && `${testID}-error`} style={[styles.error, local.message]}>{error}</Text>
        : helper ? <Text style={[styles.small, local.message]}>{helper}</Text> : null}
    </View>
  );
});

export default AppTextField;

const local = StyleSheet.create({
  field: { marginBottom: space[4] },
  leading: { width: size.icon, alignItems: 'center', marginLeft: space[3] },
  actions: { flexDirection: 'row', alignItems: 'center' },
  message: { marginTop: space[1] },
  disabled: { opacity: 0.52 },
});
