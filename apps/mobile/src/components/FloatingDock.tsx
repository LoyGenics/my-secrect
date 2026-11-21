import React, { useContext } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { Icon, type NativeIconName } from '../../../../packages/ui/src/native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { radius, size, space, textStyle } from '../ui/tokens';

export interface DockTab { key: string; label: string; icon: NativeIconName }

/**
 * iOS: an opaque floating dock (five 58 x 52 tabs, the current one a tinted
 * pill with a plum icon) plus a separate 60 pt Search circle.
 * Android: a full-width M3 navigation bar with the same five destinations;
 * Search lives in the Vault cover instead of being a sixth item.
 */
export function FloatingDock({ state, navigation, descriptors, tabs, searchRoute }: BottomTabBarProps & { tabs: readonly DockTab[]; searchRoute: string }) {
  const { colors } = useMobileTheme();
  const { dict } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext);
  const android = Platform.OS === 'android';
  const searching = state.routes[state.index]?.name === searchRoute;
  const onSearch = () => {
    const route = state.routes.find(entry => entry.name === searchRoute);
    const event = route && navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (event && !event.defaultPrevented) navigation.navigate(searchRoute);
  };
  const buttons = state.routes.map((route, index) => {
    const tab = tabs.find(entry => entry.key === route.name);
    const options = descriptors[route.key]?.options;
    const focused = state.index === index;
    const press = () => {
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
    };
    if (!tab) return null;
    const ink = focused ? colors.plum : colors.text;
    return <Pressable key={route.key} testID={options?.tabBarButtonTestID} accessibilityRole="tab"
      accessibilityLabel={options?.tabBarAccessibilityLabel ?? tab.label} accessibilityState={{ selected: focused }} onPress={press}
      style={({ pressed }) => [android ? local.m3Tab : local.tab, !android && (focused || pressed) && { backgroundColor: colors.dockSelected }]}>
      <View style={[android && local.m3Indicator, android && focused && { backgroundColor: colors.dockSelected }]}>
        <Icon name={tab.icon} size="xl" color={ink} />
      </View>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[textStyle.micro, { color: focused ? colors.plum : colors.secondaryText }]}>{tab.label}</Text>
    </Pressable>;
  });

  if (android) {
    return <View accessibilityRole="tablist" style={[local.m3Bar, { backgroundColor: colors.dock, borderTopColor: colors.border, paddingBottom: insets?.bottom ?? 0 }]}>
      {buttons}
    </View>;
  }
  return <View style={[local.frame, { backgroundColor: colors.canvas, paddingBottom: Math.max(insets?.bottom ?? 0, space[3]) }]}>
    <View accessibilityRole="tablist" style={[local.dock, local.shadow, { backgroundColor: colors.dock, borderColor: colors.border, shadowColor: colors.text }]}>{buttons}</View>
    <Pressable testID="dock-search" accessibilityRole="tab" accessibilityLabel={dict.mobileVault.search} accessibilityState={{ selected: searching }} onPress={onSearch}
      style={({ pressed }) => [local.search, local.shadow, {
        backgroundColor: searching ? colors.selected : pressed ? colors.dockSelected : colors.dock, borderColor: searching ? colors.selected : colors.border, shadowColor: colors.text,
      }]}>
      <Icon name="search" size="xl" color={searching ? colors.onSelected : colors.text} />
    </Pressable>
  </View>;
}

const local = StyleSheet.create({
  frame: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingTop: space[2] },
  dock: {
    flex: 1, minWidth: 0, height: size.dock, borderRadius: radius.dock, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space[1],
  },
  shadow: { shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  tab: { flex: 1, minWidth: 0, maxWidth: 72, minHeight: 52, borderRadius: radius.chip + 4, alignItems: 'center', justifyContent: 'center' },
  search: { width: size.dockSearch, height: size.dockSearch, borderRadius: size.dockSearch / 2, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  m3Bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space[3] },
  m3Tab: { flex: 1, minHeight: 64, alignItems: 'center', gap: space[1] },
  m3Indicator: { width: 64, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
