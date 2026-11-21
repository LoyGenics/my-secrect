import React, { useEffect, useRef, useState } from 'react';
import { Linking, Text } from 'react-native';
import { storeManagementUrl, type PurchaseOption } from '../../../../packages/sdk/src/billing';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { AppButton, AppPage, FormSection, Group, InlineError, Progress, Rule, SettingsRow } from '../components/mobile-ui';
import { AuthLayout } from '../components/AuthLayout';
import { loadStorePlans, purchaseStorePlan, restoreStorePurchases, storeConfiguration, type StorePlan } from '../mobileBilling';
import type { MobileBilling } from '../useMobileBilling';
import { useMobileTheme } from '../theme';
import { textStyle } from '../ui/tokens';

type Operation = 'purchase' | 'restore' | 'verify';

export default function BillingScreen({ billing, baseUrl, onContinue }: {
  billing: MobileBilling;
  baseUrl: string;
  onContinue?: () => void;
}) {
  const { dict, t, locale } = useTranslation();
  const { colors } = useMobileTheme();
  const m = dict.mobileBilling;
  const { access, signal } = billing;
  const paid = access?.tier === 'pro';
  const canBuy = access?.tier === 'free' && !access.checkout_blocked && !billing.pending;
  const store = storeConfiguration(access, baseUrl);
  const storeKey = store ? JSON.stringify(store) : '';
  const [plans, setPlans] = useState<StorePlan[]>();
  const [choice, setChoice] = useState<PurchaseOption>();
  const [attempt, setAttempt] = useState(0);
  const [operation, setOperation] = useState<Operation>();
  const working = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = plans?.find(plan => plan.option === choice) ?? plans?.[0];

  useEffect(() => {
    if (!store || !canBuy || !signal) return;
    let active = true;
    setPlans(undefined);
    void loadStorePlans(store, signal).then(options => {
      if (active) setPlans(options);
    }).catch(() => { if (active) setPlans([]); });
    return () => { active = false; };
  }, [storeKey, canBuy, signal, attempt]);

  async function open(url: string) {
    try { await Linking.openURL(url); }
    catch { setError(m.openLinkFailed); }
  }

  async function run(action: Operation) {
    if (!signal || working.current) return;
    working.current = true;
    setOperation(action);
    setError('');
    setNotice('');
    let verifying = false;
    try {
      if (action !== 'verify') {
        const current = await billing.request();
        if (action === 'purchase' && (current.tier === 'pro' || current.checkout_blocked)) {
          if (current.tier !== 'pro') setError(dict.billing.existing);
          return;
        }
        const currentStore = storeConfiguration(current, baseUrl);
        if (!currentStore) { setError(m.storeUnavailable); return; }
        if (action === 'restore') {
          await restoreStorePurchases(currentStore, signal);
        } else if (selected) {
          const result = await purchaseStorePlan(currentStore, selected, signal);
          if (result === 'cancelled' || signal.aborted) return;
          billing.markPending(current.app_user_id);
          if (result === 'pending') return;
        } else return;
      }
      verifying = true;
      const verified = await billing.request(true);
      if (verified.tier !== 'pro' && action === 'restore') setNotice(m.restoredNone);
    } catch {
      if (!signal.aborted) setError(verifying ? m.verifyFailed : m.purchaseFailed);
    } finally {
      working.current = false;
      setOperation(undefined);
    }
  }

  function reload() {
    setError('');
    void billing.request().then(() => setAttempt(value => value + 1)).catch(() => undefined);
  }

  const content = <>
    {onContinue && !paid && (
      <AppButton testID="billing-continue-free" label={m.freeAction} variant="secondary" disabled={Boolean(operation)} onPress={onContinue} />
    )}
    {paid && (
      <FormSection title="Pro" description={m.proBody}>
        {access.expires_at && <Text style={[textStyle.helper, { color: colors.secondaryText }]}>
          {dict.billing.accessUntil} · {new Date(access.expires_at).toLocaleDateString(locale)}
        </Text>}
      </FormSection>
    )}
    {!access && !billing.failed && <Progress label={m.checking} />}
    {billing.failed && <FormSection>
      <InlineError>{dict.billing.error}</InlineError>
      <AppButton label={dict.billing.retry} variant="text" onPress={reload} />
    </FormSection>}
    {canBuy && store && plans === undefined && <Progress label={dict.billing.loading} />}
    {canBuy && store && plans && plans.length > 0 && (
      <FormSection>
        <Group title={m.paidPlans}>
          {plans.map(({ option, package: plan }, index) => (
            <React.Fragment key={option}>
              {index > 0 && <Rule />}
              <SettingsRow testID={`billing-plan-${option}`} label={dict.billing[option]}
                detail={option === 'lifetime' ? dict.billing.noRenewal : dict.billing.recurring} value={plan.product.priceString}
                accessibilityRole="radio" selected={selected?.option === option}
                accessibilityState={{ checked: selected?.option === option }} disabled={Boolean(operation)} onPress={() => setChoice(option)} />
            </React.Fragment>
          ))}
        </Group>
        {selected && <AppButton testID="billing-buy" label={t('mobileBilling.purchase', dict.billing[selected.option])}
          loading={operation === 'purchase'} disabled={Boolean(operation)} onPress={() => void run('purchase')} />}
      </FormSection>
    )}
    {canBuy && (!store || plans?.length === 0) && (
      <FormSection description={m.storeUnavailable}>
        <AppButton label={dict.billing.retry} variant="text" onPress={reload} />
      </FormSection>
    )}
    {!paid && access?.checkout_blocked && <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{dict.billing.existing}</Text>}
    {billing.pending && <FormSection description={m.checkingPurchase}>
      <AppButton testID="billing-check-purchase" label={m.verify} variant="secondary" loading={operation === 'verify'}
        disabled={Boolean(operation)} onPress={() => void run('verify')} />
    </FormSection>}
    {error ? <InlineError testID="billing-error">{error}</InlineError> : null}
    {notice ? <Text style={[textStyle.helper, { color: colors.secondaryText }]} accessibilityLiveRegion="polite">{notice}</Text> : null}
    {Boolean(access?.purchases?.length) && (
      <Group title={dict.billing.purchases}>
        {access?.purchases.map((purchase, index) => (
          <React.Fragment key={purchase.id}>
            {index > 0 && <Rule />}
            <SettingsRow label={dict.billing[purchase.option]} value={purchase.entitled ? dict.billing.active : dict.billing.inactive}
              detail={purchase.provider === 'app_store' ? m.appleStore : purchase.provider === 'google_play' ? m.googleStore : m.webStore}
              navigation={purchase.provider !== 'stripe'} onPress={purchase.provider === 'stripe' ? undefined :
                () => void open(storeManagementUrl(purchase.provider as 'app_store' | 'google_play', purchase.option === 'lifetime'))} />
          </React.Fragment>
        ))}
      </Group>
    )}
    <FormSection>
      {store && <AppButton testID="billing-restore" label={m.restore} variant="secondary" loading={operation === 'restore'}
        disabled={Boolean(operation)} onPress={() => void run('restore')} />}
      <AppButton label={m.terms} variant="text" size="compact" onPress={() => void open(`https://msecret.app/${locale}/terms/`)} />
      <AppButton label={m.privacy} variant="text" size="compact" onPress={() => void open(`https://msecret.app/${locale}/privacy/`)} />
    </FormSection>
  </>;

  return onContinue
    ? <AuthLayout title={dict.billing.choose} subtitle={m.intro}>{content}</AuthLayout>
    : <AppPage testID="billing-screen"><FormSection description={m.intro}>{content}</FormSection></AppPage>;
}
