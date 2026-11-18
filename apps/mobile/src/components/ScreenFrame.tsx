import React from 'react';
import { Platform, SafeAreaView, StatusBar as RNStatusBar, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Keeps a screen's content out of the status bar, notch and home indicator.
 * iOS: React Native's SafeAreaView (top and bottom insets). Android: the
 * status bar is translucent (expo-status-bar), so the top inset is the
 * status bar height. Wrap each full screen once; do not nest frames.
 */
export default function ScreenFrame({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  if (Platform.OS === 'ios') return <SafeAreaView style={[{ flex: 1 }, style]}>{children}</SafeAreaView>;
  return <View style={[{ flex: 1, paddingTop: RNStatusBar.currentHeight ?? 0 }, style]}>{children}</View>;
}
