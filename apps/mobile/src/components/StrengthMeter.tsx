import React from 'react';
import { Text, View } from 'react-native';
import { useMobileTheme } from '../theme';
import { passwordStrength } from '../utils/password';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

export default function StrengthMeter({ password, testID = 'strength-meter' }: { password: string; testID?: string }) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const { score } = passwordStrength(password);
  const level = score <= 2 ? 'weak' : score <= 4 ? 'fair' : score === 5 ? 'strong' : 'veryStrong';
  const label = dict.strength.levels[level];
  const color = score <= 2 ? colors.danger : score <= 4 ? colors.warn : colors.ok;
  return (
    <View testID={testID} accessibilityLabel={format(dict.strength.meter, password ? label : dict.strength.empty)} style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.muted, fontSize: 13 }}>{dict.onboarding.strength}</Text>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{password ? label : '—'}</Text>
      </View>
      <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.input, marginTop: 6, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${(score / 6) * 100}%`, backgroundColor: color, borderRadius: 999 }} />
      </View>
    </View>
  );
}
