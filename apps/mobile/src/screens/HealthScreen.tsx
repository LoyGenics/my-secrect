import React, { useMemo } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import { illustrations } from '../../../../packages/ui/src/native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { computeHealth } from '../utils/health';
import { AppPage, EmptyState, Group, PageSection, Rule, SettingsRow } from '../components/mobile-ui';

export default function HealthScreen({ items, onFix }: { items: VaultItem[]; onFix: (item: VaultItem) => void }) {
  const { t } = useTranslation();
  const health = useMemo(() => computeHealth(items), [items]);
  const reusedIds = useMemo(() => new Set(health.reusedGroups.flatMap(({ itemIds }) => itemIds)), [health]);
  const sections = [
    { key: 'weakPasswords', items: health.weakItems },
    { key: 'reusedPasswords', items: items.filter(item => reusedIds.has(item.id)) },
    { key: 'expiring', items: health.expiringItems },
  ];
  const hasIssues = sections.some(section => section.items.length > 0);

  return (
    <AppPage testID="health-screen">
      {hasIssues ? (
        <PageSection title={t('mobileUI.healthAttention')} description={t('mobileUI.healthAttentionBody')}>
          {sections.filter(section => section.items.length > 0).map(section => (
            <Group key={section.key} title={t(`mobileUI.${section.key}`)}>
              {section.items.map((item, index) => (
                <React.Fragment key={item.id}>
                  {index > 0 && <Rule />}
                  <SettingsRow testID={`health-fix-${item.id}`} label={item.title}
                    detail={section.key === 'expiring' ? String(item.fields.expiry_date ?? item.fields.expiry ?? '') : t('mobileUI.fixPassword')}
                    onPress={() => onFix(item)} navigation />
                </React.Fragment>
              ))}
            </Group>
          ))}
        </PageSection>
      ) : (
        <EmptyState image={illustrations.healthClear}
          title={t(items.length ? 'mobileUI.healthClear' : 'mobileUI.healthEmpty')}
          detail={t(items.length ? 'mobileUI.healthClearBody' : 'mobileUI.healthEmptyBody')} />
      )}
    </AppPage>
  );
}
