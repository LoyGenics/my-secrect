import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme';
import { passwordStrength } from '../utils/password';

export default function StrengthMeter({ password, testID = 'strength-meter' }: { password: string; testID?: string }) {
  const { score, label } = passwordStrength(password);
  const color = score <= 2 ? colors.danger : score <= 4 ? colors.warn : colors.ok;
  return (
    <View testID={testID} accessibilityLabel={`Password strength: ${password ? label : 'empty'}`} style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.muted, fontSize: 13 }}>Strength</Text>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{password ? label : '—'}</Text>
      </View>
      <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.input, marginTop: 6, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${(score / 6) * 100}%`, backgroundColor: color, borderRadius: 999 }} />
      </View>
    </View>
  );
}
