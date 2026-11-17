import React from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, styles } from '../theme';

interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  testID: string;
  multiline?: boolean;
}
/** Labelled input — every form field in the app uses this, so every input
 *  has a visible label, an accessibilityLabel and a testID. */
export default function Field({ label, testID, multiline, ...props }: FieldProps) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label} accessibilityRole="text">{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={label}
        placeholderTextColor={colors.faint}
        style={[styles.input, multiline ? styles.inputMultiline : null]}
        multiline={multiline}
        {...props}
      />
    </View>
  );
}
