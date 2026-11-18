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
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useMobileTheme } from '../theme';
import Field from './Field';
import { Icon, type IconName } from '../../../../packages/ui/src/native';

/**
 * "Soft light" primitives shared by the first-run screens (sign-in, create
 * vault, unlock): docs/mockups/ui-soft-v1.html. Warm paper, white card, pill
 * actions, a floating clay hero, one rise-in per element. A filled button
 * always carries white text. Motion is skipped under reduced motion.
 */

export function useSoftPalette() {
  const { colors } = useMobileTheme();
  return { bg: colors.bg, surface: colors.card, surface2: colors.surface2, line: colors.line,
    ink: colors.text, ink2: colors.secondary, ink3: colors.muted,
    brandFill: colors.accent, brand: colors.link, brandSoft: colors.accentSoft, brandText: colors.link, focus: colors.focus,
    danger: colors.dangerText, dangerSoft: colors.dangerSoft, warnSoft: colors.warnSoft, warnText: colors.warnText };
}


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
        Animated.timing(v, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false }),
        Animated.timing(v, { toValue: 0, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false }),
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
export function Rise({ children }: { index?: number; reduced: boolean; children: ReactNode }) {
  return <View>{children}</View>;
}

export function Btn({ label, icon, onPress, disabled, busy, primary, testID }: {
  label: string; icon?: IconName; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; testID: string;
}) {
  const P = useSoftPalette();
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
        minHeight: 52,
        paddingVertical: 13,
        paddingHorizontal: 16,
        borderRadius: 12,
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
        shadowOpacity: 0,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 8 },
        elevation: 0,
      })}
    >
      {busy ? <ActivityIndicator color={color} /> : icon ? <Icon name={icon} size="lg" color={color} /> : null}
      <Text style={{ fontSize: 16, fontWeight: '700', color }}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({ label, onPress, disabled, brand, testID }: { label: string; onPress: () => void; disabled?: boolean; brand?: boolean; testID: string }) {
  const P = useSoftPalette();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: brand ? P.brandText : P.ink2, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}


/** Labelled soft input. */
export function SoftField({ icon, ...props }: TextInputProps & { label: string; testID: string; icon?: IconName }) {
  const P = useSoftPalette();
  return <Field flush leading={icon && <Icon name={icon} size="lg" color={P.ink3} />} {...props} />;
}

/** Error line. */
export function SoftAlert({ testID, children }: { testID: string; children: ReactNode }) {
  const P = useSoftPalette();
  return (
    <Text testID={testID} accessibilityRole="alert" style={{ backgroundColor: P.dangerSoft, color: P.danger, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, lineHeight: 20 }}>{children}</Text>
  );
}

export function GhostBrandMark() {
  return <Image source={require('../../../../packages/ui/assets/brand/source/ghost-key-cutout.webp')} resizeMode="contain" style={{ width: 36, height: 36 }} accessibilityIgnoresInvertColors />;
}

/** Page: brand row, floating clay hero, then a white card holding the content. */
export function SoftScreen({ art, artSize = 112, title, subtitle, children, footer }: {
  art: number; artSize?: number; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const P = useSoftPalette();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: P.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, paddingBottom: 40, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <GhostBrandMark />
            <Text style={{ fontSize: 17, fontWeight: '700', color: P.ink }}>My Secret</Text>
          </View>
          <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 20 }}>
            <Float reduced={reduced}>
              <Image source={art} accessibilityIgnoresInvertColors style={{ width: artSize, height: artSize }} resizeMode="contain" />
            </Float>

          </View>
          <View style={{ backgroundColor: P.surface, borderRadius: 14, padding: 22 }}>
            <Text accessibilityRole="header" style={{ fontSize: 27, lineHeight: 33, fontWeight: '700', letterSpacing: -0.4, color: P.ink }}>{title}</Text>
            {subtitle ? <Text style={{ fontSize: 14, lineHeight: 20, color: P.ink2, marginTop: 8 }}>{subtitle}</Text> : null}
            <View style={{ marginTop: 18, gap: 14 }}>{children}</View>
          </View>
          {footer}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
