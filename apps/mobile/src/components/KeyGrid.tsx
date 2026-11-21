import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { monoText, useMobileTheme } from '../theme';
import { radius, space, textStyle } from '../ui/tokens';
import { keyGroups } from '../utils/recoveryKeyText';

/** Numbered recovery-key cells, four per row (mono key 18/24 on a sunken r12 cell). */
export function KeyGrid({ value, testID }: { value: string; testID?: string }) {
  const { colors } = useMobileTheme();
  const groups = keyGroups(value);
  const rows: string[][] = [];
  for (let index = 0; index < groups.length; index += 4) rows.push(groups.slice(index, index + 4));
  return <View testID={testID} style={local.grid}>
    {rows.map((row, rowIndex) => (
      <View key={rowIndex} style={local.row}>
        {[0, 1, 2, 3].map((column) => {
          const group = row[column];
          const number = rowIndex * 4 + column + 1;
          if (group === undefined) return <View key={column} style={local.spacer} />;
          return <View key={column} accessible accessibilityLabel={`${number}: ${group.split('').join(' ')}`}
            style={[local.cell, { backgroundColor: colors.sunken }]}>
            <Text style={[textStyle.micro, { color: colors.secondaryText }]}>{number}</Text>
            <Text selectable style={[monoText.key, { color: colors.text }]}>{group}</Text>
          </View>;
        })}
      </View>
    ))}
  </View>;
}

const local = StyleSheet.create({
  grid: { gap: space[2] },
  row: { flexDirection: 'row', gap: space[2] },
  cell: { flex: 1, minWidth: 0, borderRadius: radius.keyCell, alignItems: 'center', paddingVertical: space[2], gap: space[1] },
  spacer: { flex: 1 },
});
