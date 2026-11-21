import React, { type ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { radius, size, space, textStyle } from '../ui/tokens';
import { Cover, CoverIconButton } from './ledger';
import { AppPage, FieldGroup } from './mobile-ui';

export function GhostBrandMark({ large }: { large?: boolean }) {
  const box = large ? space[12] + space[3] : size.brandMark;
  return <Image source={require('../../assets/icon.png')} resizeMode="cover"
    style={{ width: box, height: box, borderRadius: large ? radius.surface : radius.keyCell - 2 }} accessible={false} accessibilityIgnoresInvertColors />;
}

export interface AuthStep { index: number; labels: readonly string[]; eyebrow: string }

function StepProgress({ step }: { step: AuthStep }) {
  const { colors } = useMobileTheme();
  return <View style={local.steps} accessibilityRole="progressbar" accessibilityLabel={step.eyebrow}
    accessibilityValue={{ min: 1, max: step.labels.length, now: step.index + 1 }}>
    {step.labels.map((label, index) => {
      const done = index < step.index;
      const current = index === step.index;
      return <View key={label} style={local.step}>
        <View style={[local.bar, { backgroundColor: done || current ? colors.coverChipSelected : colors.coverChipEdge }]} />
        <View style={local.stepLabel}>
          {done && <Icon name="check" size="md" color={colors.onCoverSecondary} />}
          <Text numberOfLines={1} style={[current ? textStyle.label : textStyle.caption, { color: current ? colors.onCover : colors.onCoverSecondary }]}>{label}</Text>
        </View>
      </View>;
    })}
  </View>;
}

/**
 * Sign-in, unlock and onboarding share the cover: a full pale-plum page
 * (plum in Dark) with the app mark, or, with `step`, a cover header that
 * shows "Step n of 3" and its progress above a paper body and a pinned
 * action bar.
 */
export function AuthLayout({ title, subtitle, children, footer, step, onBack, backLabel, actions }: {
  /** @deprecated Kept for callers; the cover carries the app mark instead of art. */
  art?: number; artSize?: number;
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
  step?: AuthStep; onBack?: () => void; backLabel?: string; actions?: ReactNode;
}) {
  const { colors, styles } = useMobileTheme();
  if (step) {
    return <View style={[local.flex, { backgroundColor: colors.canvas }]}>
      <Cover title={title} eyebrow={step.eyebrow}
        leading={onBack && backLabel ? <CoverIconButton icon="back" label={backLabel} onPress={onBack} testID="auth-back" /> : undefined}>
        <StepProgress step={step} />
      </Cover>
      <AppPage footer={actions} safeArea="bottom">
        {subtitle && <Text style={[styles.subtitle, local.lede]}>{subtitle}</Text>}
        <FieldGroup>{children}</FieldGroup>
        {footer && <View style={local.footer}>{footer}</View>}
      </AppPage>
    </View>;
  }
  return (
    <AppPage safeArea="full" style={{ backgroundColor: colors.cover }} contentStyle={local.grow}>
      <View style={local.mark}><GhostBrandMark large /></View>
      <View style={local.intro}>
        <Text accessibilityRole="header" style={[textStyle.display, { color: colors.onCover }]}>{title}</Text>
        {subtitle && <Text style={[textStyle.body, { color: colors.onCoverSecondary }]}>{subtitle}</Text>}
      </View>
      <FieldGroup>{children}</FieldGroup>
      {footer && <View style={[local.footer, local.pushDown]}>{footer}</View>}
    </AppPage>
  );
}

const local = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  mark: { marginTop: space[6], marginBottom: space[6] },
  intro: { gap: space[2], marginBottom: space[6] },
  lede: { marginBottom: space[5] },
  footer: { marginTop: space[6], gap: space[3] },
  pushDown: { marginTop: 'auto', paddingTop: space[6] },
  steps: { flexDirection: 'row', gap: space[2] },
  step: { flex: 1, minWidth: 0, gap: space[2] },
  bar: { height: space[1], borderRadius: radius.full },
  stepLabel: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
});
