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
  const color = score <= 2 ? colors.dangerText : score <= 4 ? colors.warningText : colors.successText;
  const filled = password ? ['weak', 'fair', 'strong', 'veryStrong'].indexOf(level) + 1 : 0;
  return (
    <View accessible testID={testID} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 6, now: score, text: password ? label : dict.strength.empty }}
      accessibilityLabel={format(dict.strength.meter, password ? label : dict.strength.empty)} style={{ flexDirection: 'row', alignItems: 'center', gap: space[4] }}>
      <View style={{ flex: 1, flexDirection: 'row', gap: space[1] }}>
        {[1, 2, 3, 4].map(step => <View key={step} style={{ flex: 1, height: space[1], borderRadius: radius.full, backgroundColor: step <= filled ? color : colors.sunken }} />)}
      </View>
      <Text style={[textStyle.control, { color: password ? color : colors.secondaryText }]}>{password ? label : dict.onboarding.strength}</Text>
    </View>
  );
}
