import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { ChevronRight, ShieldCheck } from 'lucide-react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { illustrations } from '../../../../packages/ui/src/native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { computeHealth } from '../utils/health';
import { Empty, Group, Page, Row, Rule } from '../components/mobile-ui';

export default function HealthScreen({ items, onFix }: { items: VaultItem[]; onFix: (item: VaultItem) => void }) {
  const { colors } = useMobileTheme(); const { t } = useTranslation();
  const h = useMemo(() => computeHealth(items), [items]);
  const issues = h.weakCount + h.reusedCount + h.expiringItems.length;
  const reused = items.filter(i => h.reusedGroups.some(g => g.itemIds.includes(i.id)));
  const sections = [ { key: 'weakPasswords', items: h.weakItems }, { key: 'reusedPasswords', items: reused }, { key: 'expiring', items: h.expiringItems } ];
  if (!items.length) return <Page><Empty image={illustrations.healthClear} title={t('mobileUI.healthEmpty')} detail={t('mobileUI.healthEmptyBody')} /></Page>;
  return <Page>
    {!issues ? <Empty image={illustrations.healthClear} title={t('mobileUI.healthClear')} detail={t('mobileUI.healthClearBody')} /> : <View style={{ paddingVertical: 12, marginBottom: 24 }}><ShieldCheck size={32} color={colors.accent} /><Text style={{ color: colors.text, fontSize: 24, lineHeight: 30, fontWeight: '600', marginTop: 16 }}>{t('mobileUI.healthAttention')}</Text><Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 8 }}>{t('mobileUI.healthAttentionBody')}</Text></View>}
    {sections.map(section => <Group key={section.key} title={t(`mobileUI.${section.key}`)}>
      {section.items.length ? section.items.map((item, index) => <React.Fragment key={item.id}>{index > 0 && <Rule />}<Row testID={`health-fix-${item.id}`} label={item.title} detail={section.key === 'expiring' ? String(item.fields.expiry_date ?? item.fields.expiry ?? '') : t('mobileUI.fixPassword')} onPress={() => onFix(item)}><ChevronRight size={18} color={colors.muted} /></Row></React.Fragment>) : <Row label={t('mobileUI.itemCount', 0)}><Text style={{ color: colors.okText, fontSize: 14 }}>{t('mobileUI.healthClear')}</Text></Row>}
    </Group>)}
  </Page>;
}
