import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Icon, type IconName } from '../../../../packages/ui/src/native';

/**
 * "Soft light" primitives shared by the first-run screens (sign-in, create
 * vault, unlock): docs/mockups/ui-soft-v1.html. Warm paper, white card, pill
 * actions, a floating clay hero, one rise-in per element. A filled button
 * always carries white text. Motion is skipped under reduced motion.
 */

export const P = {
  bg: '#F6F4F1',
  surface: '#FFFFFF',
  surface2: '#FAF9F7',
  line: '#EBE8E3',
  ink: '#1E2227',
  ink2: '#565C63',
  ink3: '#8A9097',
  /** Button fill: white text on it is 4.7:1 (the lighter #FF6A2B is 2.9:1). */
  brandFill: '#D23F0C',
  brand: '#FF6A2B',
  brandSoft: '#FFF0E8',
  brandText: '#B8430F',
  danger: '#8A1F23',
  dangerSoft: '#FFE7E2',
  warnSoft: '#FFF4D8',
  warnText: '#6B4A07',
};


export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo?.isReduceMotionEnabled?.()
      .then((v: boolean) => { if (alive) setReduced(!!v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return reduced;
}

/** Slow idle float for the clay hero. */
export function Float({ children, reduced, style }: { children: ReactNode; reduced: boolean; style?: ViewStyle }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [0, -12] });
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['-1.5deg', '1.5deg'] });
  return <Animated.View style={[style, { transform: [{ translateY }, { rotate }] }]}>{children}</Animated.View>;
}

/** One entrance per element: fade + rise, staggered by `index`. */
export function Rise({ index = 0, reduced, children }: { index?: number; reduced: boolean; children: ReactNode }) {
  const v = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      v.setValue(1);
      return;
    }
    Animated.timing(v, { toValue: 1, duration: 460, delay: index * 55, easing: Easing.out(Easing.exp), useNativeDriver: true }).start();
  }, [index, reduced, v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  return <Animated.View style={{ opacity: v, transform: [{ translateY }] }}>{children}</Animated.View>;
}

export function Btn({ label, icon, onPress, disabled, busy, primary, testID }: {
  label: string; icon?: IconName; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; testID: string;
}) {
  const off = !!disabled || !!busy;
  // A filled button always carries white text.
  const color = primary ? '#FFFFFF' : P.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 52,
        borderRadius: 26,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: primary ? P.brandFill : P.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: P.line,
        opacity: disabled && !busy ? 0.55 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
        shadowColor: P.brandFill,
        shadowOpacity: primary ? 0.3 : 0,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 8 },
        elevation: primary ? 4 : 0,
      })}
    >
      {busy ? <ActivityIndicator color={color} /> : icon ? <Icon name={icon} size="lg" color={color} /> : null}
      <Text style={{ fontSize: 16, fontWeight: '700', color }}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({ label, onPress, disabled, brand, testID }: { label: string; onPress: () => void; disabled?: boolean; brand?: boolean; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: brand ? P.brandText : P.ink2, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}


/** Labelled soft input. */
export function SoftField({ label, testID, icon, ...props }: Omit<TextInputProps, 'style'> & { label: string; testID: string; icon?: IconName }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: P.ink2 }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 52, borderRadius: 14, borderWidth: 1, borderColor: P.line, backgroundColor: P.surface2, paddingHorizontal: 14 }}>
        {icon ? <Icon name={icon} size="lg" color={P.ink3} /> : null}
        <TextInput testID={testID} accessibilityLabel={label} placeholderTextColor={P.ink3} style={{ flex: 1, fontSize: 16, color: P.ink }} {...props} />
      </View>
    </View>
  );
}

/** Error line. */
export function SoftAlert({ testID, children }: { testID: string; children: ReactNode }) {
  return (
    <Text testID={testID} accessibilityRole="alert" style={{ backgroundColor: P.dangerSoft, color: P.danger, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, lineHeight: 20 }}>{children}</Text>
  );
}

export function GhostBrandMark() {
  return <Image source={require('../../../../packages/ui/assets/brand/ghost-mark.webp')} style={{ width: 36, height: 36 }} accessibilityIgnoresInvertColors />;
}

/** Page: brand row, floating clay hero, then a white card holding the content. */
export function SoftScreen({ art, artSize = 170, title, subtitle, children, footer }: {
  art: number; artSize?: number; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  const reduced = useReducedMotion();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: P.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <GhostBrandMark />
            <Text style={{ fontSize: 17, fontWeight: '700', color: P.ink }}>My Secret</Text>
          </View>
          <View style={{ alignItems: 'center', marginTop: 8, marginBottom: -8 }}>
            <Float reduced={reduced}>
              <Image source={art} accessibilityIgnoresInvertColors style={{ width: artSize, height: artSize }} resizeMode="contain" />
            </Float>
            <View style={{ width: artSize * 0.62, height: 14, borderRadius: 60, backgroundColor: 'rgba(30,20,10,0.10)', marginTop: -6 }} />
          </View>
          <View style={{ backgroundColor: P.surface, borderRadius: 28, borderWidth: 1, borderColor: P.line, padding: 22, shadowColor: '#14171C', shadowOpacity: 0.1, shadowRadius: 28, shadowOffset: { width: 0, height: 14 }, elevation: 6 }}>
            <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.4, color: P.ink }}>{title}</Text>
            {subtitle ? <Text style={{ fontSize: 14, lineHeight: 20, color: P.ink2, marginTop: 8 }}>{subtitle}</Text> : null}
            <View style={{ marginTop: 18, gap: 14 }}>{children}</View>
          </View>
          {footer}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
