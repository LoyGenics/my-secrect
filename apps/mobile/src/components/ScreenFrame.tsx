import React, { useContext } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

/** @deprecated Let AppPage or BottomSheet own the insets. */
export default function ScreenFrame({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const insets = useContext(SafeAreaInsetsContext);
  return <View style={[{ flex: 1, paddingTop: insets?.top, paddingBottom: insets?.bottom }, style]}>{children}</View>;
}
