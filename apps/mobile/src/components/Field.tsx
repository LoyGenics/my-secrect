import React, { forwardRef, useState, type ReactNode } from 'react';
import { Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { useMobileTheme } from '../theme';

interface InputControlProps extends TextInputProps {
  leading?: ReactNode;
  trailing?: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  invalid?: boolean;
}

export const InputControl = forwardRef<TextInput, InputControlProps>(function InputControl(
  { leading, trailing, containerStyle, invalid, multiline, onFocus, onBlur, style, ...props }, ref,
) {
  const { colors, styles } = useMobileTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.inputShell, containerStyle, focused && styles.inputFocused, invalid && { borderColor: colors.dangerText }]}>
      {leading && <View style={{ marginLeft: 12 }}>{leading}</View>}
      <TextInput
        ref={ref}
        multiline={multiline}
        placeholderTextColor={colors.muted}
        selectionColor={colors.focus}
        underlineColorAndroid="transparent"
        {...props}
        style={[styles.input, multiline && styles.inputMultiline, style]}
        onFocus={(event) => { setFocused(true); onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      />
      {trailing}
    </View>
  );
});

interface FieldProps extends Omit<InputControlProps, 'invalid' | 'accessibilityLabel'> {
  label: string;
  testID: string;
  error?: string;
  flush?: boolean;
}

export default forwardRef<TextInput, FieldProps>(function Field(
  { label, testID, error, flush, accessibilityHint, ...props }, ref,
) {
  const { styles } = useMobileTheme();
  return (
    <View style={flush ? undefined : { marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <InputControl
        ref={ref}
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error ?? accessibilityHint}
        invalid={!!error}
        {...props}
      />
      {error && <Text accessibilityRole="alert" style={[styles.error, { marginTop: 4 }]}>{error}</Text>}
    </View>
  );
});
