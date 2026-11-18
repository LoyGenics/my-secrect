import React from 'react';
import { Text, View } from 'react-native';
import { useMobileTheme } from '../theme';
import { passwordStrength } from '../utils/password';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';
import { radius, space, textStyle } from '../ui/tokens';

export default function StrengthMeter({ password, testID = 'strength-meter' }: { password: string; testID?: string }) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const { score } = passwordStrength(password);
  const level = score <= 2 ? 'weak' : score <= 4 ? 'fair' : score === 5 ? 'strong' : 'veryStrong';
  const label = dict.strength.levels[level];
  const color = score <= 2 ? colors.danger : score <= 4 ? colors.warn : colors.ok;
  return (
    <View accessible testID={testID} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 6, now: score, text: password ? label : dict.strength.empty }}
      accessibilityLabel={format(dict.strength.meter, password ? label : dict.strength.empty)} style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space[2] }}>
        <Text style={[textStyle.helper, { color: colors.muted }]}>{dict.onboarding.strength}</Text>
        {password && <Text style={[textStyle.helper, { color: colors.text, fontWeight: '600' }]}>{label}</Text>}
      </View>
      <View style={{ height: space[2], borderRadius: radius.full, backgroundColor: colors.input, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${(score / 6) * 100}%`, backgroundColor: color, borderRadius: radius.full }} />
      </View>
    </View>
  );
}
